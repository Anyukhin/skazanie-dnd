//! Перенос `server/world-template-catalog.mjs`: каталог заранее написанных
//! миров — комплект «мир + история + стартовая сцена».
//!
//! Записи — versioned content `data/campaign-worlds-v1.json`, которое сервер
//! выбирает только по allowlist-идентификатору. Каталог проверяется один раз
//! при первом обращении (в JS — при импорте модуля, и неверный каталог роняет
//! импорт; здесь каждый экспорт возвращает ту же ошибку). Порядок проверок —
//! строка в строку как в JS: первым срабатывает тот же отказ с тем же текстом.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{js, re, text as jstext};
use sk_heroes::authored_npc::{normalize_authored_npc_mechanics_at, AuthoredNpcValidationError};
use sk_themes::scene_themes::SCENE_THEME_IDS;
use sk_world_life::world_offices::validate_office_configuration;

pub const WORLD_TEMPLATE_SCHEMA_VERSION: i64 = 1;
pub const WORLD_RULES_SCHEMA_VERSION: i64 = 1;
pub const WORLD_TEMPLATE_COUNT: usize = 4;
/// Источник `WORLD_TEMPLATE_IMAGE_PATTERN` (флаг `u`).
pub const WORLD_TEMPLATE_IMAGE_PATTERN: &str = r"^/assets/maps/world/skazanie/[a-z0-9][a-z0-9-]*-v[1-9][0-9]*\.webp$";
/// Источник `CITY_OVERVIEW_IMAGE_PATTERN` (флаг `u`).
pub const CITY_OVERVIEW_IMAGE_PATTERN: &str = r"^/assets/maps/city/skazanie/[a-z0-9][a-z0-9-]*-v[1-9][0-9]*\.webp$";

static CATALOG_TEXT: &str = include_str!("../../../../data/campaign-worlds-v1.json");

const WORLD_KINDS: [&str; 10] = ["capital", "city", "town", "village", "port", "fortress", "ruin", "dungeon", "landmark", "wilds"];
const SETTLEMENT_KINDS: [&str; 6] = ["capital", "city", "town", "village", "port", "fortress"];
const WORLD_BIOMES: [&str; 8] = ["plains", "forest", "mountains", "marsh", "desert", "tundra", "coast", "wastes"];
const ROUTE_KINDS: [&str; 5] = ["road", "trail", "river", "sea", "pass"];
const DANGERS: [&str; 3] = ["низкая", "средняя", "высокая"];
const SCENE_MAP_PATTERNS: [&str; 10] = ["small-room", "great-hall", "keep", "courtyard", "crypt", "temple", "cave-cluster", "village", "bridge", "natural"];
const SCENE_MAP_LAYOUTS: [&str; 7] = ["rooms", "streets", "open", "winding", "cavern", "ruins", "radial"];
const CITY_PLACE_KINDS: [&str; 12] = ["civic", "harbor", "market", "temple", "archive", "gate", "tower", "garden", "workshop", "infrastructure", "inn", "other"];
const OPENING_SECRET_SKILLS: [&str; 9] = ["investigation", "perception", "survival", "insight", "history", "arcana", "religion", "nature", "medicine"];
const VISIBILITIES: [&str; 3] = ["public", "party", "gm_only"];

const LIMIT_ID: usize = 80;
const LIMIT_NAME: usize = 160;
const LIMIT_SHORT: usize = 360;
const LIMIT_DESCRIPTION: usize = 2_000;
const LIMIT_HISTORY: usize = 12_000;
const LIMIT_WORLD: usize = 1_200;

/// Отказ каталога. `name` — класс ошибки JS: `WorldTemplateCatalogError`, а
/// для боевого листа NPC — `AuthoredNpcValidationError` (её каталог в JS не
/// перехватывает).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldTemplateCatalogError {
    pub name: &'static str,
    pub code: String,
    pub message: String,
}

impl WorldTemplateCatalogError {
    pub const NAME: &'static str = "WorldTemplateCatalogError";
    pub const CODE: &'static str = "WORLD_TEMPLATE_INVALID";

    pub fn new(message: impl Into<String>) -> Self {
        Self { name: Self::NAME, code: Self::CODE.into(), message: message.into() }
    }
}

impl From<AuthoredNpcValidationError> for WorldTemplateCatalogError {
    fn from(error: AuthoredNpcValidationError) -> Self {
        Self { name: AuthoredNpcValidationError::NAME, code: error.code, message: error.message }
    }
}

impl std::fmt::Display for WorldTemplateCatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for WorldTemplateCatalogError {}

type R<T> = Result<T, WorldTemplateCatalogError>;

fn fail<T>(message: impl Into<String>) -> R<T> {
    Err(WorldTemplateCatalogError::new(message))
}

// ---------------------------------------------------------------------------
// Приведения JS
// ---------------------------------------------------------------------------

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, limit)` по единицам UTF-16. Разрез посреди суррогатной
/// пары в JS оставил бы одиночный суррогат; здесь пара отбрасывается целиком.
fn utf16_head(text: &str, limit: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for ch in text.chars() {
        used += ch.len_utf16();
        if used > limit {
            break;
        }
        out.push(ch);
    }
    out
}

/// `value?.[name]`: собственное поле объекта.
fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

/// `field(source, ...names)`: первое поле, которое не `undefined` (`null` —
/// тоже значение).
fn field<'a>(source: Option<&'a Value>, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| get(source, name))
}

fn is_nullish(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

/// `a ?? b`.
fn coalesce<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    if is_nullish(value) {
        fallback
    } else {
        value
    }
}

/// `{ ...clone(source) }` в порядке ключей JS (индексы раньше прочих).
fn spread(source: &Map<String, Value>) -> Map<String, Value> {
    js::entries(source).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect()
}

fn object<'a>(value: Option<&'a Value>, path: &str) -> R<&'a Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Ok(map),
        _ => fail(format!("{path} должен быть объектом")),
    }
}

fn array<'a>(value: Option<&'a Value>, path: &str, minimum: usize) -> R<&'a [Value]> {
    match value {
        Some(Value::Array(items)) if items.len() >= minimum => Ok(items),
        _ => fail(format!("{path} должен содержать не менее {minimum} записей")),
    }
}

/// `array(value, path, minimum)` с дробным минимумом (`locations.length - 1`).
fn array_min_f64<'a>(value: Option<&'a Value>, path: &str, minimum: f64) -> R<&'a [Value]> {
    match value {
        Some(Value::Array(items)) if items.len() as f64 >= minimum => Ok(items),
        _ => fail(format!("{path} должен содержать не менее {} записей", js::f64_string(minimum))),
    }
}

fn text(value: Option<&Value>, path: &str, maximum: usize) -> R<String> {
    let Some(Value::String(raw)) = value else {
        return fail(format!("{path} должен быть непустым текстом"));
    };
    if jstext::trim(raw).is_empty() {
        return fail(format!("{path} должен быть непустым текстом"));
    }
    let result = jstext::trim(&jstext::nfkc(raw).replace('\r', "")).to_string();
    if utf16_len(&result) > maximum {
        return fail(format!("{path} длиннее {maximum} символов"));
    }
    Ok(result)
}

fn optional_text(value: Option<&Value>, path: &str, maximum: usize) -> R<String> {
    if is_nullish(value) || matches!(value, Some(Value::String(text)) if text.is_empty()) {
        return Ok(String::new());
    }
    text(value, path, maximum)
}

fn integer(value: Option<&Value>, path: &str, minimum: f64, maximum: f64, fallback: Option<f64>) -> R<f64> {
    if is_nullish(value) {
        if let Some(fallback) = fallback {
            return Ok(fallback);
        }
    }
    let result = js::number(value);
    if !js::is_safe_integer_number(value) || result < minimum || result > maximum {
        return fail(format!("{path} должен быть целым числом от {} до {}", js::f64_string(minimum), js::f64_string(maximum)));
    }
    Ok(result)
}

fn boolean(value: Option<&Value>, path: &str, fallback: bool) -> R<bool> {
    if is_nullish(value) {
        return Ok(fallback);
    }
    match value {
        Some(Value::Bool(flag)) => Ok(*flag),
        _ => fail(format!("{path} должен быть boolean")),
    }
}

fn is_safe_ascii_id(value: &str) -> bool {
    jstext::test(re!(r"^[a-z0-9][a-z0-9_-]{0,79}$", "u"), value)
}

fn id(value: Option<&Value>, path: &str) -> R<String> {
    let result = text(value, path, LIMIT_ID)?;
    if !is_safe_ascii_id(&result) {
        return fail(format!("{path} должен быть безопасным ASCII-идентификатором"));
    }
    Ok(result)
}

fn world_rule_id(value: Option<&Value>, path: &str) -> R<String> {
    let result = text(value, path, LIMIT_ID)?;
    if !jstext::test(re!(r"^[a-z0-9][a-z0-9_-]{0,79}(?::[a-z0-9][a-z0-9_-]{0,79})?$", "u"), &result) {
        return fail(format!("{path} должен быть безопасным ASCII-идентификатором"));
    }
    Ok(result)
}

fn world_rule_tag(value: Option<&Value>, path: &str) -> R<String> {
    let result = text(value, path, LIMIT_ID)?;
    if !is_safe_ascii_id(&result) {
        return fail(format!("{path} должен быть безопасным ASCII-тегом"));
    }
    Ok(result)
}

fn num(value: f64) -> Value {
    js::num(value)
}

/// `a < b` по правилам JS для значений, уже прошедших `integer(...)`.
fn js_less(left: Option<&Value>, right: Option<&Value>) -> bool {
    fn primitive(value: Option<&Value>) -> Value {
        match value {
            Some(Value::Array(_)) | Some(Value::Object(_)) => Value::String(js::s(value)),
            Some(other) => other.clone(),
            None => Value::Null,
        }
    }
    let (left, right) = (primitive(left), primitive(right));
    if let (Value::String(a), Value::String(b)) = (&left, &right) {
        return a.encode_utf16().lt(b.encode_utf16());
    }
    js::number(Some(&left)) < js::number(Some(&right))
}

// ---------------------------------------------------------------------------
// Проверки частей шаблона
// ---------------------------------------------------------------------------

/// Есть ли файл картинки в `public/` (`existsSync(join(PROJECT_ROOT, 'public', …))`).
pub type ImageExists<'a> = &'a dyn Fn(&str) -> bool;

/// Проверка по умолчанию: `public/` корня данных процесса
/// (`sk_core::data_root`, С19.1).
pub fn image_exists_in_project(image: &str) -> bool {
    let relative = image.strip_prefix('/').unwrap_or(image);
    sk_core::data_root::join("public").join(relative).exists()
}

struct Checker<'a> {
    image_exists: ImageExists<'a>,
}

fn normalize_themes(value: Option<&Value>, path: &str) -> R<Value> {
    if let Some(Value::Array(items)) = value {
        let mut values = Vec::with_capacity(items.len());
        for (index, entry) in items.iter().enumerate() {
            values.push(Value::String(text(Some(entry), &format!("{path}[{index}]"), 160)?));
        }
        if values.is_empty() {
            return fail(format!("{path} не должен быть пустым"));
        }
        return Ok(Value::Array(values));
    }
    Ok(Value::String(text(value, path, LIMIT_WORLD)?))
}

fn resolve_name(entries: &[Value], value: Option<&Value>, path: &str) -> R<String> {
    let wanted = text(value, path, LIMIT_NAME)?;
    if let Some(entry) = entries.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some(wanted.as_str())) {
        return Ok(js::s(entry.get("id")));
    }
    if let Some(entry) = entries.iter().find(|entry| entry.get("name").and_then(Value::as_str) == Some(wanted.as_str())) {
        return Ok(js::s(entry.get("id")));
    }
    fail(format!("{path} ссылается на неизвестную запись «{wanted}»"))
}

const RICH_TEXT_FIELDS: [&str; 14] = ["summary", "description", "text", "details", "detail", "title", "name", "label", "hook", "objective", "event", "impact", "consequence", "used_for"];

fn rich_text_for(value: Option<&Value>, path: &str) -> R<String> {
    if let Some(Value::String(_)) = value {
        return text(value, path, LIMIT_HISTORY);
    }
    object(value, path)?;
    let candidate = field(value, &RICH_TEXT_FIELDS).cloned();
    if is_nullish(candidate.as_ref()) {
        return fail(format!("{path} не содержит текста истории"));
    }
    text(candidate.as_ref(), &format!("{path}.summary"), LIMIT_HISTORY)
}

fn validate_rich_collection(value: Option<&Value>, path: &str, require_ids: bool) -> R<Vec<Value>> {
    let source = array(value, path, 1)?;
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(source.len());
    for (index, entry) in source.iter().enumerate() {
        let item_path = format!("{path}[{index}]");
        if let Value::String(_) = entry {
            rich_text_for(Some(entry), &item_path)?;
            if require_ids {
                return fail(format!("{item_path} должен иметь id"));
            }
            out.push(entry.clone());
            continue;
        }
        object(Some(entry), &item_path)?;
        let candidate_id = field(Some(entry), &["id", "arc_id", "hook_id", "faction_id"]);
        if !is_nullish(candidate_id) {
            let item_id = id(candidate_id, &format!("{item_path}.id"))?;
            if !seen.insert(item_id.clone()) {
                return fail(format!("{path} содержит повторяющийся id «{item_id}»"));
            }
        } else if require_ids {
            return fail(format!("{item_path}.id обязателен"));
        }
        rich_text_for(Some(entry), &item_path)?;
        out.push(entry.clone());
    }
    Ok(out)
}

impl Checker<'_> {
    fn image(&self, value: Option<&Value>, path: &str, city: bool, what: &str) -> R<String> {
        let image = text(value, path, 240)?;
        let pattern = if city { re!(CITY_OVERVIEW_IMAGE_PATTERN, "u") } else { re!(WORLD_TEMPLATE_IMAGE_PATTERN, "u") };
        if !jstext::test(pattern, &image) {
            return fail(format!("{path} должен быть внутренним WebP-путём {what}"));
        }
        if !(self.image_exists)(&image) {
            return fail(format!("{path} указывает на отсутствующий файл {image}"));
        }
        Ok(image)
    }

    fn world_image(&self, value: Option<&Value>, path: &str) -> R<String> {
        self.image(value, path, false, "карты мира")
    }

    fn city_image(&self, value: Option<&Value>, path: &str) -> R<String> {
        self.image(value, path, true, "городского плана")
    }

    fn city_overview(&self, raw: Option<&Value>, path: &str) -> R<Value> {
        let source = object(raw, path)?;
        let f = |key: &str| source.get(key);
        let version = integer(f("version"), &format!("{path}.version"), 1.0, 99.0, None)?;
        let width = integer(f("width"), &format!("{path}.width"), 320.0, 2_000.0, None)?;
        let height = integer(f("height"), &format!("{path}.height"), 240.0, 1_200.0, None)?;
        let image = self.city_image(f("image"), &format!("{path}.image"))?;
        let source_value = Some(raw.unwrap_or(&Value::Null));
        let image_alt = text(field(source_value, &["imageAlt", "image_alt"]), &format!("{path}.imageAlt"), 300)?;
        let mut district_ids: HashSet<String> = HashSet::new();
        let districts_source = array(f("districts"), &format!("{path}.districts"), 6)?;
        if districts_source.len() != 6 {
            return fail(format!("{path}.districts должен содержать ровно шесть районов"));
        }
        let mut districts = Vec::new();
        for (index, raw_district) in districts_source.iter().enumerate() {
            let item_path = format!("{path}.districts[{index}]");
            let district = object(Some(raw_district), &item_path)?;
            let d = |key: &str| district.get(key);
            let district_id = id(d("id"), &format!("{item_path}.id"))?;
            if !district_ids.insert(district_id.clone()) {
                return fail(format!("{path}.districts содержит повторяющийся id «{district_id}»"));
            }
            let x = integer(d("x"), &format!("{item_path}.x"), 35.0, width - 35.0, None)?;
            let y = integer(d("y"), &format!("{item_path}.y"), 35.0, height - 35.0, None)?;
            let raw_bounds = object(d("bounds"), &format!("{item_path}.bounds"))?;
            let b = |key: &str| raw_bounds.get(key);
            let bounds_x = integer(b("x"), &format!("{item_path}.bounds.x"), 20.0, width - 80.0, None)?;
            let bounds_y = integer(b("y"), &format!("{item_path}.bounds.y"), 20.0, height - 80.0, None)?;
            let bounds_width = integer(b("width"), &format!("{item_path}.bounds.width"), 80.0, width - bounds_x, None)?;
            let bounds_height = integer(b("height"), &format!("{item_path}.bounds.height"), 80.0, height - bounds_y, None)?;
            if bounds_x + bounds_width > width || bounds_y + bounds_height > height {
                return fail(format!("{item_path}.bounds выходит за карту"));
            }
            let name = text(d("name"), &format!("{item_path}.name"), 120)?;
            let summary = text(d("summary"), &format!("{item_path}.summary"), 500)?;
            let history = text(d("history"), &format!("{item_path}.history"), 1_200)?;
            let story_hooks = city_hooks(field(Some(raw_district), &["storyHooks", "story_hooks"]), &format!("{item_path}.storyHooks"))?;
            districts.push(json!({
                "id": district_id, "name": name, "x": num(x), "y": num(y),
                "bounds": { "x": num(bounds_x), "y": num(bounds_y), "width": num(bounds_width), "height": num(bounds_height) },
                "summary": summary, "history": history, "storyHooks": story_hooks,
            }));
        }
        let mut place_ids: HashSet<String> = HashSet::new();
        let places_source = array(f("places"), &format!("{path}.places"), 10)?;
        if places_source.len() != 10 {
            return fail(format!("{path}.places должен содержать ровно десять мест"));
        }
        let mut places = Vec::new();
        for (index, raw_place) in places_source.iter().enumerate() {
            let item_path = format!("{path}.places[{index}]");
            let place = object(Some(raw_place), &item_path)?;
            let p = |key: &str| place.get(key);
            let place_id = id(p("id"), &format!("{item_path}.id"))?;
            if !place_ids.insert(place_id.clone()) {
                return fail(format!("{path}.places содержит повторяющийся id «{place_id}»"));
            }
            let district_id = id(field(Some(raw_place), &["districtId", "district_id"]), &format!("{item_path}.districtId"))?;
            if !district_ids.contains(&district_id) {
                return fail(format!("{item_path}.districtId ссылается на неизвестный район"));
            }
            let kind = text(p("kind"), &format!("{item_path}.kind"), 40)?;
            if !CITY_PLACE_KINDS.contains(&kind.as_str()) {
                return fail(format!("{item_path}.kind имеет недопустимое значение"));
            }
            let name = text(p("name"), &format!("{item_path}.name"), 120)?;
            let x = integer(p("x"), &format!("{item_path}.x"), 25.0, width - 25.0, None)?;
            let y = integer(p("y"), &format!("{item_path}.y"), 25.0, height - 25.0, None)?;
            let summary = text(p("summary"), &format!("{item_path}.summary"), 500)?;
            let history = text(p("history"), &format!("{item_path}.history"), 1_200)?;
            let story_hooks = city_hooks(field(Some(raw_place), &["storyHooks", "story_hooks"]), &format!("{item_path}.storyHooks"))?;
            places.push(json!({
                "id": place_id, "name": name, "kind": kind, "districtId": district_id, "x": num(x), "y": num(y),
                "summary": summary, "history": history, "storyHooks": story_hooks,
            }));
        }
        let name = text(f("name"), &format!("{path}.name"), LIMIT_NAME)?;
        let summary = text(f("summary"), &format!("{path}.summary"), LIMIT_DESCRIPTION)?;
        Ok(json!({
            "version": num(version), "name": name, "summary": summary, "image": image, "imageAlt": image_alt,
            "width": num(width), "height": num(height), "districts": districts, "places": places,
        }))
    }
}

fn city_hooks(value: Option<&Value>, path: &str) -> R<Value> {
    let hooks = array(value, path, 2)?;
    if hooks.len() != 2 {
        return fail(format!("{path} должен содержать ровно две зацепки"));
    }
    let mut out = Vec::new();
    for (index, entry) in hooks.iter().enumerate() {
        out.push(Value::String(text(Some(entry), &format!("{path}[{index}]"), 320)?));
    }
    Ok(Value::Array(out))
}

struct Metadata {
    template: Value,
    template_id: String,
    version: Value,
    name: String,
    tagline: String,
    description: String,
    image: String,
    image_alt: String,
    accent: String,
    focus: Vec<Value>,
    recommended_levels: Value,
}

impl Checker<'_> {
    fn metadata(&self, raw: Option<&Value>, index: usize) -> R<Metadata> {
        let path = format!("templates[{index}]");
        let template = object(raw, &path)?;
        let t = |key: &str| template.get(key);
        let template_id = id(t("id"), &format!("{path}.id"))?;
        let version = match t("version") {
            Some(Value::Number(number)) if js::is_safe_integer_number(t("version")) && number.as_f64().is_some_and(|value| value >= 1.0) => Value::Number(number.clone()),
            other => {
                let label = text(other, &format!("{path}.version"), 40)?;
                if !jstext::test(re!(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$", "u"), &label) {
                    return fail(format!("{path}.version должен быть положительным числом или semver-строкой"));
                }
                Value::String(label)
            }
        };
        let name = text(t("name"), &format!("{path}.name"), LIMIT_NAME)?;
        let tagline = text(t("tagline"), &format!("{path}.tagline"), LIMIT_SHORT)?;
        let description = text(t("description"), &format!("{path}.description"), LIMIT_DESCRIPTION)?;
        let image = self.world_image(t("image"), &format!("{path}.image"))?;
        let image_alt = text(field(raw, &["imageAlt", "image_alt"]), &format!("{path}.imageAlt"), LIMIT_SHORT)?;
        let accent = text(t("accent"), &format!("{path}.accent"), 80)?;
        let mut focus = Vec::new();
        if let Some(Value::Array(items)) = t("focus") {
            for (entry_index, entry) in items.iter().enumerate() {
                focus.push(Value::String(text(Some(entry), &format!("{path}.focus[{entry_index}]"), 120)?));
            }
            focus.truncate(8);
        } else {
            focus.push(Value::String(text(t("focus"), &format!("{path}.focus"), LIMIT_SHORT)?));
        }
        if focus.is_empty() {
            return fail(format!("{path}.focus не должен быть пустым"));
        }
        let recommended = field(raw, &["recommendedLevels", "recommended_levels"]);
        match recommended {
            Some(Value::String(_)) => {
                text(recommended, &format!("{path}.recommendedLevels"), 80)?;
            }
            Some(Value::Array(items)) => {
                if items.is_empty() {
                    return fail(format!("{path}.recommendedLevels не должен быть пустым"));
                }
                for (entry_index, entry) in items.iter().enumerate() {
                    integer(Some(entry), &format!("{path}.recommendedLevels[{entry_index}]"), 1.0, 20.0, None)?;
                }
            }
            Some(Value::Object(range)) => {
                integer(range.get("min"), &format!("{path}.recommendedLevels.min"), 1.0, 20.0, None)?;
                integer(range.get("max"), &format!("{path}.recommendedLevels.max"), 1.0, 20.0, None)?;
                if js_less(range.get("max"), range.get("min")) {
                    return fail(format!("{path}.recommendedLevels задан неверно"));
                }
            }
            _ => return fail(format!("{path}.recommendedLevels должен быть строкой, массивом или диапазоном")),
        }
        Ok(Metadata {
            template: Value::Object(template.clone()),
            template_id,
            version,
            name,
            tagline,
            description,
            image,
            image_alt,
            accent,
            focus,
            recommended_levels: recommended.cloned().unwrap_or(Value::Null),
        })
    }
}

fn validate_world(raw: Option<&Value>, path: &str, start_name: Option<&Value>) -> R<Value> {
    let source = object(raw, path)?;
    let s = |key: &str| source.get(key);
    let mut world = spread(source);
    world.insert("preset".into(), Value::String(optional_text(field(raw, &["preset", "setting"]), &format!("{path}.preset"), 240)?));
    world.insert("era".into(), Value::String(text(s("era"), &format!("{path}.era"), LIMIT_WORLD)?));
    world.insert("genre".into(), Value::String(text(s("genre"), &format!("{path}.genre"), LIMIT_WORLD)?));
    world.insert("tone".into(), Value::String(text(s("tone"), &format!("{path}.tone"), LIMIT_WORLD)?));
    world.insert("themes".into(), normalize_themes(s("themes"), &format!("{path}.themes"))?);
    world.insert("premise".into(), Value::String(optional_text(s("premise"), &format!("{path}.premise"), LIMIT_DESCRIPTION)?));
    world.insert("boundaries".into(), Value::String(optional_text(s("boundaries"), &format!("{path}.boundaries"), LIMIT_SHORT)?));
    world.insert("magicLevel".into(), Value::String(optional_text(field(raw, &["magicLevel", "magic_level"]), &format!("{path}.magicLevel"), 120)?));
    world.insert("technologyLevel".into(), Value::String(optional_text(field(raw, &["technologyLevel", "technology_level"]), &format!("{path}.technologyLevel"), 120)?));
    let starting = coalesce(field(raw, &["startingLocation", "starting_location"]), start_name);
    world.insert("startingLocation".into(), Value::String(text(starting, &format!("{path}.startingLocation"), LIMIT_NAME)?));
    Ok(Value::Object(world))
}

impl Checker<'_> {
    fn world_map(&self, raw: Option<&Value>, path: &str) -> R<Value> {
        let source = object(raw, path)?;
        let s = |key: &str| source.get(key);
        let width = integer(s("width"), &format!("{path}.width"), 320.0, 2_000.0, Some(1_000.0))?;
        let height = integer(s("height"), &format!("{path}.height"), 240.0, 1_200.0, Some(640.0))?;
        let routes_complete = boolean(s("routesComplete"), &format!("{path}.routesComplete"), false)?;
        let background_value = field(raw, &["backgroundImage", "background_image"]);
        let background_image = if is_nullish(background_value) { String::new() } else { self.world_image(background_value, &format!("{path}.backgroundImage"))? };
        let background_alt = if background_image.is_empty() {
            String::new()
        } else {
            optional_text(field(raw, &["backgroundAlt", "background_alt"]), &format!("{path}.backgroundAlt"), LIMIT_SHORT)?
        };
        let raw_regions = array(s("regions"), &format!("{path}.regions"), 5)?;
        let mut region_ids: HashSet<String> = HashSet::new();
        let mut regions: Vec<Value> = Vec::new();
        for (index, raw_region) in raw_regions.iter().enumerate() {
            let item_path = format!("{path}.regions[{index}]");
            let raw_item = object(Some(raw_region), &item_path)?;
            let r = |key: &str| raw_item.get(key);
            let region_id = id(r("id"), &format!("{item_path}.id"))?;
            if !region_ids.insert(region_id.clone()) {
                return fail(format!("{path}.regions содержит повторяющийся id «{region_id}»"));
            }
            let biome = text(r("biome"), &format!("{item_path}.biome"), 40)?;
            if !WORLD_BIOMES.contains(&biome.as_str()) {
                return fail(format!("{item_path}.biome имеет недопустимое значение"));
            }
            let mut region = spread(raw_item);
            region.insert("id".into(), Value::String(region_id));
            region.insert("name".into(), Value::String(text(r("name"), &format!("{item_path}.name"), LIMIT_NAME)?));
            region.insert("biome".into(), Value::String(biome));
            region.insert("x".into(), num(integer(r("x"), &format!("{item_path}.x"), 45.0, (width - 45.0).min(955.0), None)?));
            region.insert("y".into(), num(integer(r("y"), &format!("{item_path}.y"), 45.0, (height - 45.0).min(595.0), None)?));
            region.insert("radius".into(), num(integer(r("radius"), &format!("{item_path}.radius"), 60.0, 500.0, None)?));
            regions.push(Value::Object(region));
        }

        let raw_locations = array(s("locations"), &format!("{path}.locations"), 12)?;
        let mut location_ids: HashSet<String> = HashSet::new();
        let mut locations: Vec<Value> = Vec::new();
        for (index, raw_location) in raw_locations.iter().enumerate() {
            let item_path = format!("{path}.locations[{index}]");
            let raw_item = object(Some(raw_location), &item_path)?;
            let r = |key: &str| raw_item.get(key);
            let location_id = id(r("id"), &format!("{item_path}.id"))?;
            if !location_ids.insert(location_id.clone()) {
                return fail(format!("{path}.locations содержит повторяющийся id «{location_id}»"));
            }
            let kind = text(r("kind"), &format!("{item_path}.kind"), 40)?;
            if !WORLD_KINDS.contains(&kind.as_str()) {
                return fail(format!("{item_path}.kind имеет недопустимое значение"));
            }
            let region_reference = field(Some(raw_location), &["regionId", "region_id", "region"]);
            let region_id = resolve_name(&regions, region_reference, &format!("{item_path}.regionId"))?;
            let summary = text(field(Some(raw_location), &["summary", "description", "lore"]), &format!("{item_path}.summary"), LIMIT_DESCRIPTION)?;
            let history = text(r("history"), &format!("{item_path}.history"), LIMIT_HISTORY)?;
            let hooks_path = format!("{item_path}.storyHooks");
            let mut story_hooks = Vec::new();
            for (hook_index, entry) in array(coalesce(r("storyHooks"), r("story_hooks")), &hooks_path, 1)?.iter().enumerate() {
                story_hooks.push(Value::String(text(Some(entry), &format!("{item_path}.storyHooks[{hook_index}]"), LIMIT_SHORT)?));
            }
            let raw_city = field(Some(raw_location), &["cityOverview", "city_overview"]);
            let city_overview = if is_nullish(raw_city) { None } else { Some(self.city_overview(raw_city, &format!("{item_path}.cityOverview"))?) };
            let mut location = spread(raw_item);
            location.insert("id".into(), Value::String(location_id));
            location.insert("name".into(), Value::String(text(r("name"), &format!("{item_path}.name"), LIMIT_NAME)?));
            location.insert("kind".into(), Value::String(kind));
            location.insert("regionId".into(), Value::String(region_id));
            location.insert("x".into(), num(integer(r("x"), &format!("{item_path}.x"), 45.0, (width - 45.0).min(955.0), None)?));
            location.insert("y".into(), num(integer(r("y"), &format!("{item_path}.y"), 45.0, (height - 45.0).min(595.0), None)?));
            location.insert("summary".into(), Value::String(summary));
            location.insert("history".into(), Value::String(history));
            location.insert("storyHooks".into(), Value::Array(story_hooks));
            if let Some(city) = city_overview {
                location.insert("cityOverview".into(), city);
            }
            location.insert("known".into(), Value::Bool(boolean(r("known"), &format!("{item_path}.known"), true)?));
            location.insert("visited".into(), Value::Bool(boolean(r("visited"), &format!("{item_path}.visited"), false)?));
            locations.push(Value::Object(location));
        }
        let settlements = locations.iter().filter(|location| SETTLEMENT_KINDS.contains(&location["kind"].as_str().unwrap_or_default())).count();
        if settlements < 5 {
            return fail(format!("{path}.locations должен содержать не менее пяти поселений"));
        }

        let raw_routes = array_min_f64(s("routes"), &format!("{path}.routes"), locations.len() as f64 - 1.0)?;
        let mut route_ids: HashSet<String> = HashSet::new();
        let mut routes: Vec<Value> = Vec::new();
        for (index, raw_route) in raw_routes.iter().enumerate() {
            let item_path = format!("{path}.routes[{index}]");
            let raw_item = object(Some(raw_route), &item_path)?;
            let r = |key: &str| raw_item.get(key);
            let route_id = id(r("id"), &format!("{item_path}.id"))?;
            if !route_ids.insert(route_id.clone()) {
                return fail(format!("{path}.routes содержит повторяющийся id «{route_id}»"));
            }
            let from = resolve_name(&locations, field(Some(raw_route), &["from", "fromId", "from_id"]), &format!("{item_path}.from"))?;
            let to = resolve_name(&locations, field(Some(raw_route), &["to", "toId", "to_id"]), &format!("{item_path}.to"))?;
            if from == to {
                return fail(format!("{item_path} не может соединять место с самим собой"));
            }
            let kind = text(r("kind"), &format!("{item_path}.kind"), 40)?;
            if !ROUTE_KINDS.contains(&kind.as_str()) {
                return fail(format!("{item_path}.kind имеет недопустимое значение"));
            }
            let danger = text(r("danger"), &format!("{item_path}.danger"), 40)?;
            if !DANGERS.contains(&danger.as_str()) {
                return fail(format!("{item_path}.danger имеет недопустимое значение"));
            }
            let mut route = spread(raw_item);
            route.insert("id".into(), Value::String(route_id));
            route.insert("from".into(), Value::String(from));
            route.insert("to".into(), Value::String(to));
            route.insert("kind".into(), Value::String(kind));
            route.insert("distance".into(), num(integer(r("distance"), &format!("{item_path}.distance"), 1.0, 30.0, None)?));
            route.insert("danger".into(), Value::String(danger));
            route.insert("discovered".into(), Value::Bool(boolean(r("discovered"), &format!("{item_path}.discovered"), true)?));
            routes.push(Value::Object(route));
        }
        let mut map = spread(source);
        map.insert("version".into(), num(integer(s("version"), &format!("{path}.version"), 1.0, 999_999.0, Some(1.0))?));
        map.insert("routesComplete".into(), Value::Bool(routes_complete));
        map.insert("name".into(), Value::String(text(s("name"), &format!("{path}.name"), LIMIT_NAME)?));
        map.insert("width".into(), num(width));
        map.insert("height".into(), num(height));
        map.insert("regions".into(), Value::Array(regions));
        map.insert("locations".into(), Value::Array(locations));
        map.insert("routes".into(), Value::Array(routes));
        if !background_image.is_empty() {
            map.insert("backgroundImage".into(), Value::String(background_image));
            if !background_alt.is_empty() {
                map.insert("backgroundAlt".into(), Value::String(background_alt));
            }
        }
        Ok(Value::Object(map))
    }
}

struct OpeningDefaults<'a> {
    campaign_name: Option<&'a Value>,
    world_summary: Option<&'a Value>,
    world_history: Option<&'a Value>,
}

fn validate_opening(raw: Option<&Value>, path: &str, world_map: &Value, defaults: &OpeningDefaults<'_>) -> R<Value> {
    let source = object(raw, path)?;
    let s = |key: &str| source.get(key);
    let scene = object(s("scene"), &format!("{path}.scene"))?;
    let scene_value = s("scene");
    let sc = |key: &str| scene.get(key);
    let location_id = id(field(scene_value, &["locationId", "location_id"]), &format!("{path}.scene.locationId"))?;
    let locations = world_map["locations"].as_array().map(Vec::as_slice).unwrap_or_default();
    let Some(start) = locations.iter().find(|location| location["id"].as_str() == Some(location_id.as_str())) else {
        return fail(format!("{path}.scene.locationId не найден на карте"));
    };
    let location = text(sc("location"), &format!("{path}.scene.location"), LIMIT_NAME)?;
    if start["name"].as_str() != Some(location.as_str()) {
        return fail(format!("{path}.scene.location не совпадает с locationId"));
    }
    if start["visited"] != Value::Bool(true) {
        return fail(format!("{path}.scene.locationId должен указывать на посещённую стартовую точку"));
    }
    let scene_map = object(sc("map"), &format!("{path}.scene.map"))?;
    let map_value = sc("map");
    if !is_nullish(scene_map.get("layout")) && !SCENE_MAP_LAYOUTS.contains(&text(scene_map.get("layout"), &format!("{path}.scene.map.layout"), 40)?.as_str()) {
        return fail(format!("{path}.scene.map.layout имеет недопустимое значение"));
    }
    if !is_nullish(scene_map.get("pattern")) && !SCENE_MAP_PATTERNS.contains(&text(scene_map.get("pattern"), &format!("{path}.scene.map.pattern"), 40)?.as_str()) {
        return fail(format!("{path}.scene.map.pattern имеет недопустимое значение"));
    }
    let scene_theme_id = field(map_value, &["theme_id", "themeId"]);
    if !is_nullish(scene_theme_id) && !SCENE_THEME_IDS.contains(text(scene_theme_id, &format!("{path}.scene.map.theme_id"), 40)?.as_str()) {
        return fail(format!("{path}.scene.map.theme_id имеет недопустимое значение"));
    }
    let danger = text(sc("danger"), &format!("{path}.scene.danger"), 40)?;
    if !DANGERS.contains(&danger.as_str()) {
        return fail(format!("{path}.scene.danger имеет недопустимое значение"));
    }
    let npcs = array(s("npcs"), &format!("{path}.npcs"), 1)?;
    if npcs.len() > 12 {
        return fail(format!("{path}.npcs не должен содержать больше двенадцати записей"));
    }
    let start_id = js::s(start.get("id"));
    let start_name = js::s(start.get("name"));
    let mut npc_ids: HashSet<String> = HashSet::new();
    let mut normalized_npcs: Vec<Value> = Vec::new();
    for (index, raw_npc) in npcs.iter().enumerate() {
        let npc_path = format!("{path}.npcs[{index}]");
        let npc = object(Some(raw_npc), &npc_path)?;
        let n = |key: &str| npc.get(key);
        let mut goals = Vec::new();
        if let Some(Value::Array(items)) = n("goals") {
            for (goal_index, entry) in items.iter().enumerate() {
                goals.push(Value::String(text(Some(entry), &format!("{npc_path}.goals[{goal_index}]"), 240)?));
            }
            goals.truncate(4);
        }
        let mut beliefs = Vec::new();
        if let Some(Value::Array(items)) = n("beliefs") {
            for (belief_index, entry) in items.iter().enumerate() {
                beliefs.push(Value::String(text(Some(entry), &format!("{npc_path}.beliefs[{belief_index}]"), 240)?));
            }
            beliefs.truncate(4);
        }
        let npc_id = if is_nullish(n("id")) { String::new() } else { id(n("id"), &format!("{npc_path}.id"))? };
        if !npc_id.is_empty() && npc_ids.contains(&npc_id) {
            return fail(format!("{path}.npcs содержит повторяющийся id «{npc_id}»"));
        }
        if !npc_id.is_empty() {
            npc_ids.insert(npc_id.clone());
        }
        let npc_location_id = if is_nullish(n("location")) { start_id.clone() } else { resolve_name(locations, n("location"), &format!("{npc_path}.location"))? };
        let npc_location = locations
            .iter()
            .find(|entry| entry["id"].as_str() == Some(npc_location_id.as_str()))
            .and_then(|entry| coalesce(entry.get("name"), None))
            .cloned()
            .unwrap_or_else(|| Value::String(start_name.clone()));
        let npc_visibility = if is_nullish(n("visibility")) { "party".to_string() } else { text(n("visibility"), &format!("{npc_path}.visibility"), 20)? };
        if !VISIBILITIES.contains(&npc_visibility.as_str()) {
            return fail(format!("{npc_path}.visibility имеет недопустимое значение"));
        }
        let reveal_on_presence = js::is_true(n("reveal_on_presence"));
        if reveal_on_presence && npc_visibility != "gm_only" {
            return fail(format!("{npc_path}.reveal_on_presence разрешён только закрытому NPC"));
        }
        let mut out = spread(npc);
        if !npc_id.is_empty() {
            out.insert("id".into(), Value::String(npc_id));
        }
        out.insert("name".into(), Value::String(text(n("name"), &format!("{npc_path}.name"), LIMIT_NAME)?));
        out.insert("role".into(), Value::String(optional_text(n("role"), &format!("{npc_path}.role"), LIMIT_SHORT)?));
        out.insert("location".into(), npc_location);
        out.insert("location_id".into(), Value::String(npc_location_id));
        out.insert("visibility".into(), Value::String(npc_visibility));
        if reveal_on_presence {
            out.insert("reveal_on_presence".into(), Value::Bool(true));
        }
        out.insert("summary".into(), Value::String(text(field(Some(raw_npc), &["summary", "description", "lore"]), &format!("{npc_path}.summary"), LIMIT_SHORT)?));
        out.insert("voice".into(), Value::String(optional_text(n("voice"), &format!("{npc_path}.voice"), LIMIT_SHORT)?));
        out.insert("goals".into(), Value::Array(goals));
        out.insert("beliefs".into(), Value::Array(beliefs));
        if !is_nullish(n("mechanics")) {
            out.insert("mechanics".into(), normalize_authored_npc_mechanics_at(n("mechanics"), &format!("{npc_path}.mechanics"))?);
        }
        normalized_npcs.push(Value::Object(out));
    }
    let mut opening = spread(source);
    opening.insert(
        "campaignName".into(),
        Value::String(text(coalesce(field(raw, &["campaignName", "campaign_name", "name"]), defaults.campaign_name), &format!("{path}.campaignName"), LIMIT_NAME)?),
    );
    opening.insert("partyName".into(), Value::String(optional_text(field(raw, &["partyName", "party_name"]), &format!("{path}.partyName"), LIMIT_NAME)?));
    opening.insert(
        "worldSummary".into(),
        Value::String(text(coalesce(field(raw, &["worldSummary", "world_summary"]), defaults.world_summary), &format!("{path}.worldSummary"), LIMIT_DESCRIPTION)?),
    );
    opening.insert(
        "worldHistory".into(),
        Value::String(text(coalesce(field(raw, &["worldHistory", "world_history"]), defaults.world_history), &format!("{path}.worldHistory"), LIMIT_HISTORY)?),
    );
    opening.insert(
        "openingNarration".into(),
        Value::String(text(field(raw, &["openingNarration", "opening_narration", "narration"]), &format!("{path}.openingNarration"), LIMIT_HISTORY)?),
    );
    let mut scene_out = spread(scene);
    scene_out.insert("locationId".into(), Value::String(location_id.clone()));
    scene_out.insert("location_id".into(), Value::String(location_id));
    scene_out.insert("location".into(), Value::String(location));
    scene_out.insert("title".into(), Value::String(text(sc("title"), &format!("{path}.scene.title"), LIMIT_NAME)?));
    scene_out.insert("mood".into(), Value::String(text(sc("mood"), &format!("{path}.scene.mood"), LIMIT_SHORT)?));
    scene_out.insert("objective".into(), Value::String(text(sc("objective"), &format!("{path}.scene.objective"), LIMIT_SHORT)?));
    scene_out.insert("theme".into(), Value::String(text(sc("theme"), &format!("{path}.scene.theme"), LIMIT_SHORT)?));
    scene_out.insert("danger".into(), Value::String(danger));
    let mut map_out = spread(scene_map);
    if !is_nullish(scene_theme_id) {
        map_out.insert("theme_id".into(), Value::String(text(scene_theme_id, &format!("{path}.scene.map.theme_id"), 40)?));
    }
    scene_out.insert("map".into(), Value::Object(map_out));
    opening.insert("scene".into(), Value::Object(scene_out));
    opening.insert("hook".into(), Value::String(text(s("hook"), &format!("{path}.hook"), LIMIT_SHORT)?));
    let secrets = validate_opening_secrets(s("secrets"), &format!("{path}.secrets"), &normalized_npcs)?;
    opening.insert("npcs".into(), Value::Array(normalized_npcs));
    opening.insert("secrets".into(), Value::Array(secrets));
    Ok(Value::Object(opening))
}

fn validate_opening_secrets(raw: Option<&Value>, path: &str, npcs: &[Value]) -> R<Vec<Value>> {
    if is_nullish(raw) {
        return Ok(Vec::new());
    }
    let entries = array(raw, path, 1)?;
    if entries.len() > 6 {
        return fail(format!("{path} не должен содержать больше шести записей"));
    }
    let names: HashSet<String> = npcs.iter().map(|npc| js::s(npc.get("name"))).collect();
    let mut out = Vec::new();
    for (index, raw_secret) in entries.iter().enumerate() {
        let secret_path = format!("{path}[{index}]");
        let secret = object(Some(raw_secret), &secret_path)?;
        let mut skills = Vec::new();
        for (skill_index, skill) in array(secret.get("skills"), &format!("{secret_path}.skills"), 1)?.iter().enumerate() {
            let value = text(Some(skill), &format!("{secret_path}.skills[{skill_index}]"), 40)?;
            if !OPENING_SECRET_SKILLS.contains(&value.as_str()) {
                return fail(format!("{secret_path}.skills содержит неизвестный навык «{value}»"));
            }
            skills.push(Value::String(value));
        }
        let holder = optional_text(secret.get("holder"), &format!("{secret_path}.holder"), LIMIT_NAME)?;
        if !holder.is_empty() && !names.contains(&holder) {
            return fail(format!("{secret_path}.holder «{holder}» не найден среди NPC сцены"));
        }
        let topic = text(secret.get("topic"), &format!("{secret_path}.topic"), LIMIT_SHORT)?;
        let clue = text(secret.get("clue"), &format!("{secret_path}.clue"), LIMIT_SHORT)?;
        let mut entry = Map::new();
        entry.insert("topic".into(), Value::String(topic));
        entry.insert("skills".into(), Value::Array(skills));
        if !holder.is_empty() {
            entry.insert("holder".into(), Value::String(holder));
        }
        entry.insert("clue".into(), Value::String(clue));
        out.push(Value::Object(entry));
    }
    Ok(out)
}

struct ResponsibilityScope<'a> {
    npc_ids: &'a IndexSet<String>,
    office_ids: &'a IndexSet<String>,
    expected_type: &'a str,
    expected_death_policy: &'a str,
}

fn validate_world_responsibility(raw: Option<&Value>, path: &str, scope: &ResponsibilityScope<'_>) -> R<Value> {
    let source = object(raw, path)?;
    let kind = text(source.get("type"), &format!("{path}.type"), 20)?;
    if kind != "npc" && kind != "office" {
        return fail(format!("{path}.type имеет недопустимое значение"));
    }
    if !scope.expected_type.is_empty() && kind != scope.expected_type {
        return fail(format!("{path}.type должен быть {}", scope.expected_type));
    }
    let death_policy = text(source.get("death_policy"), &format!("{path}.death_policy"), 20)?;
    if death_policy != "impossible" && death_policy != "transfer" {
        return fail(format!("{path}.death_policy имеет недопустимое значение"));
    }
    if !scope.expected_death_policy.is_empty() && death_policy != scope.expected_death_policy {
        return fail(format!("{path}.death_policy должен быть {}", scope.expected_death_policy));
    }
    let mut out = spread(source);
    out.insert("schema_version".into(), json!(1));
    out.insert("type".into(), Value::String(kind.clone()));
    if kind == "npc" {
        let npc_id = id(field(raw, &["npc_id", "npcId"]), &format!("{path}.npc_id"))?;
        if !scope.npc_ids.contains(&npc_id) {
            return fail(format!("{path}.npc_id ссылается на неизвестного NPC «{npc_id}»"));
        }
        out.insert("npc_id".into(), Value::String(npc_id));
    } else {
        let office_id = world_rule_id(field(raw, &["office_id", "officeId"]), &format!("{path}.office_id"))?;
        if !scope.office_ids.contains(&office_id) {
            return fail(format!("{path}.office_id ссылается на неизвестную должность «{office_id}»"));
        }
        out.insert("office_id".into(), Value::String(office_id));
    }
    out.insert("death_policy".into(), Value::String(death_policy));
    Ok(Value::Object(out))
}

fn faction_id_set(factions: &[Value], path: &str) -> R<IndexSet<String>> {
    let mut ids = IndexSet::new();
    for faction in factions {
        ids.insert(id(field(Some(faction), &["id", "faction_id"]), &format!("{path}.factions.id"))?);
    }
    Ok(ids)
}

fn validate_world_rules(raw: Option<&Value>, path: &str, opening_npcs: &[Value], factions: &[Value]) -> R<Option<Value>> {
    if is_nullish(raw) {
        return Ok(None);
    }
    let source = object(raw, path)?;
    let schema_version = integer(source.get("schema_version"), &format!("{path}.schema_version"), WORLD_RULES_SCHEMA_VERSION as f64, WORLD_RULES_SCHEMA_VERSION as f64, None)?;
    let npc_ids: IndexSet<String> = opening_npcs.iter().filter(|npc| js::truthy(npc.get("id"))).map(|npc| js::s(npc.get("id"))).collect();
    let faction_ids = faction_id_set(factions, path)?;
    let raw_offices = array(source.get("offices"), &format!("{path}.offices"), 1)?;
    if raw_offices.len() > 12 {
        return fail(format!("{path}.offices не должен содержать больше двенадцати записей"));
    }
    let mut office_ids: IndexSet<String> = IndexSet::new();
    let mut offices: Vec<Value> = Vec::new();
    for (index, raw_office) in raw_offices.iter().enumerate() {
        let office_path = format!("{path}.offices[{index}]");
        let office = object(Some(raw_office), &office_path)?;
        let office_id = world_rule_id(office.get("id"), &format!("{office_path}.id"))?;
        if !office_ids.insert(office_id.clone()) {
            return fail(format!("{path}.offices содержит повторяющийся id «{office_id}»"));
        }
        let faction_id = id(field(Some(raw_office), &["faction_id", "factionId"]), &format!("{office_path}.faction_id"))?;
        if !faction_ids.contains(&faction_id) {
            return fail(format!("{office_path}.faction_id ссылается на неизвестную фракцию «{faction_id}»"));
        }
        let holder_npc_id = id(field(Some(raw_office), &["holder_npc_id", "holderNpcId"]), &format!("{office_path}.holder_npc_id"))?;
        if !npc_ids.contains(&holder_npc_id) {
            return fail(format!("{office_path}.holder_npc_id ссылается на неизвестного NPC «{holder_npc_id}»"));
        }
        let visibility = text(office.get("visibility"), &format!("{office_path}.visibility"), 20)?;
        if !VISIBILITIES.contains(&visibility.as_str()) {
            return fail(format!("{office_path}.visibility имеет недопустимое значение"));
        }
        let Some(Value::Array(raw_defenders)) = field(Some(raw_office), &["defender_npc_ids", "defenderNpcIds"]) else {
            return fail(format!("{office_path}.defender_npc_ids должен быть массивом"));
        };
        if raw_defenders.len() > 12 {
            return fail(format!("{office_path}.defender_npc_ids не должен содержать больше двенадцати записей"));
        }
        let mut defender_ids: HashSet<String> = HashSet::new();
        let mut defender_npc_ids = Vec::new();
        for (defender_index, value) in raw_defenders.iter().enumerate() {
            let defender_id = id(Some(value), &format!("{office_path}.defender_npc_ids[{defender_index}]"))?;
            if !npc_ids.contains(&defender_id) {
                return fail(format!("{office_path}.defender_npc_ids[{defender_index}] ссылается на неизвестного NPC «{defender_id}»"));
            }
            if !defender_ids.insert(defender_id.clone()) {
                return fail(format!("{office_path}.defender_npc_ids содержит повторяющийся id «{defender_id}»"));
            }
            defender_npc_ids.push(Value::String(defender_id));
        }
        let successor_path = format!("{office_path}.successor");
        let successor_value = field(Some(raw_office), &["successor"]);
        object(successor_value, &successor_path)?;
        let successor_npc_id = id(field(successor_value, &["npc_id", "npcId"]), &format!("{successor_path}.npc_id"))?;
        if !npc_ids.contains(&successor_npc_id) {
            return fail(format!("{successor_path}.npc_id ссылается на неизвестного NPC «{successor_npc_id}»"));
        }
        let delay_minutes = integer(field(successor_value, &["delay_minutes", "delayMinutes"]), &format!("{successor_path}.delay_minutes"), 1.0, 10_000_000.0, None)?;
        let raw_required = field(successor_value, &["required_tags", "requiredTags"]);
        let raw_required = match raw_required {
            Some(Value::Array(items)) if !items.is_empty() => items,
            _ => return fail(format!("{successor_path}.required_tags должен содержать хотя бы один тег")),
        };
        if raw_required.len() > 12 {
            return fail(format!("{successor_path}.required_tags не должен содержать больше двенадцати тегов"));
        }
        let mut required_ids: HashSet<String> = HashSet::new();
        let mut required_tags = Vec::new();
        for (tag_index, value) in raw_required.iter().enumerate() {
            let tag = world_rule_tag(Some(value), &format!("{successor_path}.required_tags[{tag_index}]"))?;
            if !required_ids.insert(tag.clone()) {
                return fail(format!("{successor_path}.required_tags содержит повторяющийся тег «{tag}»"));
            }
            required_tags.push(Value::String(tag));
        }
        let configuration = json!({
            "id": office_id,
            "title": text(office.get("title"), &format!("{office_path}.title"), LIMIT_NAME)?,
            "faction_id": faction_id,
            "holder_npc_id": holder_npc_id,
            "visibility": visibility,
            "defender_npc_ids": defender_npc_ids,
            "successor": { "npc_id": successor_npc_id, "delay_minutes": num(delay_minutes), "required_tags": required_tags },
        });
        let context = json!({
            "knownNpcIds": npc_ids.iter().cloned().collect::<Vec<_>>(),
            "knownFactionIds": faction_ids.iter().cloned().collect::<Vec<_>>(),
        });
        match validate_office_configuration(Some(&configuration), &context) {
            Ok(office) => offices.push(office),
            Err(error) => return fail(format!("{office_path}: {}", error.message)),
        }
    }

    let starter_path = format!("{path}.starter_responsibility");
    let starter = validate_world_responsibility(
        field(raw, &["starter_responsibility", "starterResponsibility"]),
        &starter_path,
        &ResponsibilityScope { npc_ids: &npc_ids, office_ids: &office_ids, expected_type: "npc", expected_death_policy: "impossible" },
    )?;
    let raw_quests = array(field(raw, &["offered_quests", "offeredQuests"]), &format!("{path}.offered_quests"), 1)?;
    if raw_quests.len() > 12 {
        return fail(format!("{path}.offered_quests не должен содержать больше двенадцати записей"));
    }
    let mut quest_ids: HashSet<String> = HashSet::new();
    let mut quests: Vec<Value> = Vec::new();
    for (index, raw_quest) in raw_quests.iter().enumerate() {
        let quest_path = format!("{path}.offered_quests[{index}]");
        let quest = object(Some(raw_quest), &quest_path)?;
        let q = |key: &str| quest.get(key);
        let quest_id = world_rule_id(q("id"), &format!("{quest_path}.id"))?;
        if !quest_ids.insert(quest_id.clone()) {
            return fail(format!("{path}.offered_quests содержит повторяющийся id «{quest_id}»"));
        }
        let status = text(q("status"), &format!("{quest_path}.status"), 20)?;
        if status != "offered" {
            return fail(format!("{quest_path}.status должен быть offered"));
        }
        let visibility = text(q("visibility"), &format!("{quest_path}.visibility"), 20)?;
        if !VISIBILITIES.contains(&visibility.as_str()) {
            return fail(format!("{quest_path}.visibility имеет недопустимое значение"));
        }
        let giver_npc_id = id(field(Some(raw_quest), &["giver_npc_id", "giverNpcId"]), &format!("{quest_path}.giver_npc_id"))?;
        if !npc_ids.contains(&giver_npc_id) {
            return fail(format!("{quest_path}.giver_npc_id ссылается на неизвестного NPC «{giver_npc_id}»"));
        }
        let responsibility = validate_world_responsibility(
            q("responsibility"),
            &format!("{quest_path}.responsibility"),
            &ResponsibilityScope { npc_ids: &npc_ids, office_ids: &office_ids, expected_type: "office", expected_death_policy: "transfer" },
        )?;
        let Some(office) = offices.iter().find(|entry| entry.get("id") == responsibility.get("office_id")) else {
            return fail(format!("{quest_path}.responsibility.office_id ссылается на неизвестную должность"));
        };
        if office.get("holder_npc_id").and_then(Value::as_str) != Some(giver_npc_id.as_str()) {
            return fail(format!("{quest_path}.giver_npc_id должен быть текущим держателем должности"));
        }
        let mut out = spread(quest);
        out.insert("id".into(), Value::String(quest_id));
        out.insert("title".into(), Value::String(text(q("title"), &format!("{quest_path}.title"), LIMIT_NAME)?));
        if !is_nullish(q("summary")) {
            out.insert("summary".into(), Value::String(optional_text(q("summary"), &format!("{quest_path}.summary"), LIMIT_SHORT)?));
        }
        out.insert("status".into(), Value::String(status));
        out.insert("visibility".into(), Value::String(visibility));
        out.insert("giver_npc_id".into(), Value::String(giver_npc_id));
        out.insert("responsibility".into(), responsibility);
        quests.push(Value::Object(out));
    }
    let mut rules = spread(source);
    rules.insert("schema_version".into(), num(schema_version));
    rules.insert("offices".into(), Value::Array(offices));
    rules.insert("starter_responsibility".into(), starter);
    rules.insert("offered_quests".into(), Value::Array(quests));
    Ok(Some(Value::Object(rules)))
}

fn validate_graph(world_map: &Value, start_id: &str, path: &str) -> R<()> {
    let locations = world_map["locations"].as_array().map(Vec::as_slice).unwrap_or_default();
    let mut adjacency: sk_core::indexmap::IndexMap<String, IndexSet<String>> = locations.iter().map(|location| (js::s(location.get("id")), IndexSet::new())).collect();
    for route in world_map["routes"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let from = js::s(route.get("from"));
        let to = js::s(route.get("to"));
        if let Some(links) = adjacency.get_mut(&from) {
            links.insert(to.clone());
        }
        if let Some(links) = adjacency.get_mut(&to) {
            links.insert(from);
        }
    }
    let mut seen: IndexSet<String> = IndexSet::new();
    seen.insert(start_id.to_string());
    let mut queue = vec![start_id.to_string()];
    let mut cursor = 0;
    while cursor < queue.len() {
        let current = queue[cursor].clone();
        for next in adjacency.get(&current).map(|links| links.iter().cloned().collect::<Vec<_>>()).unwrap_or_default() {
            if seen.insert(next.clone()) {
                queue.push(next);
            }
        }
        cursor += 1;
    }
    if seen.len() != locations.len() {
        let missing: Vec<String> = locations.iter().map(|location| js::s(location.get("id"))).filter(|location_id| !seen.contains(location_id)).collect();
        return fail(format!("{path} не связана со стартовой точкой; недостижимы: {}", missing.join(", ")));
    }
    Ok(())
}

impl Checker<'_> {
    fn template(&self, raw: Option<&Value>, index: usize) -> R<Value> {
        let metadata = self.metadata(raw, index)?;
        let source = &metadata.template;
        let src = Some(source);
        let path = format!("templates[{index}]");
        let world_map = self.world_map(field(src, &["world_map", "worldMap"]), &format!("{path}.world_map"))?;
        let raw_opening = object(get(src, "opening"), &format!("{path}.opening"))?;
        object(raw_opening.get("scene"), &format!("{path}.opening.scene"))?;
        let opening_location = field(raw_opening.get("scene"), &["location", "location_name"]);
        let empty = json!({});
        let world = validate_world(Some(coalesce(field(src, &["world", "world_concept"]), None).unwrap_or(&empty)), &format!("{path}.world"), opening_location)?;
        let name_value = Value::String(metadata.name.clone());
        let description_value = Value::String(metadata.description.clone());
        let defaults = OpeningDefaults {
            campaign_name: Some(&name_value),
            world_summary: coalesce(coalesce(field(src, &["worldSummary", "world_summary"]), world.get("worldSummary")), Some(&description_value)),
            world_history: coalesce(coalesce(field(src, &["worldHistory", "world_history"]), world.get("worldHistory")), Some(&description_value)),
        };
        let mut opening = validate_opening(get(src, "opening"), &format!("{path}.opening"), &world_map, &defaults)?;
        let locations = world_map["locations"].as_array().map(Vec::as_slice).unwrap_or_default();
        let overview: Vec<&Value> = locations.iter().filter(|location| js::truthy(location.get("cityOverview"))).collect();
        if overview.len() != 1 || overview[0].get("id") != opening["scene"].get("locationId") {
            return fail(format!("{path}.world_map должен содержать один городской план только у стартовой точки"));
        }
        if world.get("startingLocation") != opening["scene"].get("location") {
            return fail(format!("{path}.world.startingLocation не совпадает со стартовой сценой"));
        }
        let histories: Vec<Value> = locations
            .iter()
            .map(|location| json!({ "id": location["id"], "locationId": location["id"], "title": location["name"], "summary": location["history"] }))
            .collect();
        let story_hooks: Vec<Value> = locations
            .iter()
            .flat_map(|location| {
                location["storyHooks"].as_array().cloned().unwrap_or_default().into_iter().enumerate().map(move |(hook_index, hook)| {
                    json!({ "id": format!("{}-hook-{}", js::s(location.get("id")), hook_index + 1), "locationId": location["id"], "title": location["name"], "summary": hook })
                })
            })
            .collect();
        let timeline = validate_rich_collection(get(src, "timeline"), &format!("{path}.timeline"), false)?;
        let factions = validate_rich_collection(get(src, "factions"), &format!("{path}.factions"), true)?;
        let opening_npcs = opening["npcs"].as_array().cloned().unwrap_or_default();
        let world_rules = validate_world_rules(field(Some(&opening), &["world_rules", "worldRules"]), &format!("{path}.opening.world_rules"), &opening_npcs, &factions)?;
        if let (Some(rules), Value::Object(map)) = (world_rules, &mut opening) {
            map.insert("world_rules".into(), rules);
        }
        let faction_ids = faction_id_set(&factions, &path)?;
        let mut profile_ids: HashSet<String> = HashSet::new();
        for npc in &opening_npcs {
            let faction = npc.get("faction_id");
            if !is_nullish(faction) && !faction_ids.contains(&id(faction, &format!("{path}.opening.npcs.faction_id"))?) {
                return fail(format!("{path}.opening.npcs содержит неизвестную фракцию «{}»", js::string(faction)));
            }
            if !js::truthy(npc.get("mechanics")) {
                continue;
            }
            let profile = js::string(npc["mechanics"].get("profile_id"));
            if !profile_ids.insert(profile.clone()) {
                return fail(format!("{path}.opening.npcs содержит повторяющийся mechanics.profile_id «{profile}»"));
            }
        }
        let story_arcs = validate_rich_collection(field(src, &["story_arcs", "storyArcs"]), &format!("{path}.story_arcs"), false)?;
        let mut out = match source {
            Value::Object(map) => spread(map),
            _ => Map::new(),
        };
        out.insert("id".into(), Value::String(metadata.template_id));
        out.insert("version".into(), metadata.version);
        out.insert("name".into(), Value::String(metadata.name));
        out.insert("tagline".into(), Value::String(metadata.tagline));
        out.insert("description".into(), Value::String(metadata.description));
        out.insert("image".into(), Value::String(metadata.image));
        out.insert("imageAlt".into(), Value::String(metadata.image_alt.clone()));
        out.insert("image_alt".into(), Value::String(metadata.image_alt));
        out.insert("accent".into(), Value::String(metadata.accent));
        out.insert("focus".into(), Value::Array(metadata.focus));
        out.insert("recommendedLevels".into(), metadata.recommended_levels.clone());
        out.insert("recommended_levels".into(), metadata.recommended_levels);
        out.insert("world".into(), world);
        out.insert("world_map".into(), world_map);
        out.insert("opening".into(), opening);
        out.insert("histories".into(), Value::Array(histories));
        out.insert("storyHooks".into(), Value::Array(story_hooks));
        out.insert("timeline".into(), Value::Array(timeline));
        out.insert("factions".into(), Value::Array(factions));
        out.insert("story_arcs".into(), Value::Array(story_arcs));
        Ok(Value::Object(out))
    }
}

/// Проверка разобранного каталога (`loadCatalog` после `JSON.parse`): шаблоны
/// в порядке файла или первый отказ. `image_exists` — есть ли картинка в
/// `public/` (в JS — `existsSync`). Отдельной функции в JS нет: так каталог
/// проверяется на чужих данных в тестах переноса.
pub fn validate_world_template_catalog(payload: &Value, image_exists: ImageExists<'_>) -> R<Vec<Value>> {
    let checker = Checker { image_exists };
    let root = object(Some(payload), "catalog")?;
    let schema = root.get("schema_version");
    let is_current = matches!(schema, Some(Value::Number(number)) if number.as_f64() == Some(WORLD_TEMPLATE_SCHEMA_VERSION as f64));
    if !is_current {
        return fail(format!("catalog.schema_version должен быть {WORLD_TEMPLATE_SCHEMA_VERSION}"));
    }
    validate_rich_collection(root.get("inspiration_sources"), "catalog.inspiration_sources", false)?;
    let templates = array(root.get("templates"), "catalog.templates", WORLD_TEMPLATE_COUNT)?;
    if templates.len() != WORLD_TEMPLATE_COUNT {
        return fail(format!("Каталог должен содержать ровно {WORLD_TEMPLATE_COUNT} шаблона"));
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut normalized = Vec::new();
    for (index, entry) in templates.iter().enumerate() {
        let template = checker.template(Some(entry), index)?;
        let template_id = js::s(template.get("id"));
        if !seen.insert(template_id.clone()) {
            return fail(format!("Каталог содержит повторяющийся template id «{template_id}»"));
        }
        validate_graph(&template["world_map"], &js::s(template["opening"]["scene"].get("locationId")), &format!("templates[{index}].world_map"))?;
        normalized.push(template);
    }
    Ok(normalized)
}

static WORLD_TEMPLATES: LazyLock<R<Vec<Value>>> = LazyLock::new(|| match serde_json::from_str::<Value>(CATALOG_TEXT) {
    Ok(payload) => validate_world_template_catalog(&payload, &image_exists_in_project),
    Err(error) => fail(format!("Не удалось загрузить каталог миров: {error}")),
});

/// Путь каталога миров от корня репозитория.
pub const WORLD_TEMPLATE_CATALOG_FILE: &str = "data/campaign-worlds-v1.json";

/// Разбор и проверка каталога миров из текста — та же проверка, что у
/// встроенного каталога (для тестов — сломанные копии).
pub fn parse_world_template_catalog(text: &str, image_exists: ImageExists<'_>) -> sk_core::content::ContentResult<Vec<Value>> {
    let payload = sk_core::content::parse_json(WORLD_TEMPLATE_CATALOG_FILE, text)?;
    validate_world_template_catalog(&payload, image_exists).map_err(|error| sk_core::content::ContentError::new(WORLD_TEMPLATE_CATALOG_FILE, error.message))
}

/// Проверка встроенного каталога (урок 7; сервер зовёт её до приёма запросов,
/// как JS проверяет каталог при загрузке модуля). Картинки ищутся в
/// `public/` корня данных процесса.
pub fn check_world_template_catalog() -> sk_core::content::ContentResult<()> {
    catalog().map(|_| ()).map_err(|error| sk_core::content::ContentError::new(WORLD_TEMPLATE_CATALOG_FILE, error.message))
}

fn catalog() -> R<&'static [Value]> {
    match &*WORLD_TEMPLATES {
        Ok(templates) => Ok(templates),
        Err(error) => Err(error.clone()),
    }
}

fn template_for(value: Option<&Value>) -> R<&'static Value> {
    let requested = match value {
        Some(Value::String(_)) => value,
        other => get(other, "id"),
    };
    let key = jstext::trim(&js::s(requested)).to_string();
    match catalog()?.iter().find(|template| template.get("id").and_then(Value::as_str) == Some(key.as_str())) {
        Some(template) => Ok(template),
        None => fail(format!("Неизвестный шаблон мира «{}»", if key.is_empty() { "(пусто)" } else { &key })),
    }
}

fn history_teaser(template: &Value) -> R<String> {
    let explicit = field(Some(template), &["historyTeaser", "history_teaser"]);
    if js::truthy(explicit) {
        return text(explicit, "historyTeaser", 360);
    }
    let first = template["histories"].get(0);
    Ok(utf16_head(&rich_text_for(first, "histories[0]")?, 360))
}

fn version_label(value: &Value) -> String {
    match value {
        Value::Number(_) => format!("{}.0.0", js::s(Some(value))),
        other => js::string(Some(other)),
    }
}

fn public_preview(template: &Value) -> R<Value> {
    let map = &template["world_map"];
    let locations = map["locations"].as_array().map(Vec::as_slice).unwrap_or_default();
    let settlements: Vec<&Value> = locations.iter().filter(|location| SETTLEMENT_KINDS.contains(&location["kind"].as_str().unwrap_or_default())).collect();
    let city_names: Vec<Value> = settlements.iter().map(|location| location["name"].clone()).take(24).collect();
    let count = |key: &str| map[key].as_array().map_or(0, Vec::len);
    let map_counts = json!({
        "regions": count("regions"), "locations": count("locations"), "routes": count("routes"), "settlements": settlements.len(),
    });
    let world = &template["world"];
    Ok(json!({
        "id": template["id"],
        "version": version_label(&template["version"]),
        "name": template["name"],
        "tagline": template["tagline"],
        "description": utf16_head(template["description"].as_str().unwrap_or_default(), LIMIT_DESCRIPTION),
        "image": template["image"],
        "imageAlt": template["imageAlt"],
        "accent": template["accent"],
        "focus": template["focus"],
        "recommendedLevels": template["recommendedLevels"],
        "world": {
            "era": world["era"], "genre": world["genre"], "tone": world["tone"], "themes": world["themes"], "startingLocation": world["startingLocation"],
        },
        "cities": city_names,
        "cityNames": city_names,
        "cityCount": settlements.len(),
        "regionCount": count("regions"),
        "locationCount": count("locations"),
        "routeCount": count("routes"),
        "mapCounts": map_counts,
        "historyTeaser": history_teaser(template)?,
        "cityOverviewCount": locations.iter().filter(|location| js::truthy(location.get("cityOverview"))).count(),
    }))
}

/// `listWorldTemplates()`: витрина шаблонов для выбора мира.
pub fn list_world_templates() -> R<Vec<Value>> {
    catalog()?.iter().map(public_preview).collect()
}

/// `getWorldTemplate(id)`: проверенный шаблон целиком (копия).
pub fn get_world_template(id_value: Option<&Value>) -> R<Value> {
    template_for(id_value).cloned()
}

/// `worldTemplateOpening(template, overrides)`: стартовый комплект кампании.
pub fn world_template_opening(template_value: Option<&Value>, overrides: &Value) -> R<Value> {
    let template = template_for(template_value)?;
    let opening = &template["opening"];
    let o = Some(overrides);
    let campaign_override = optional_text(coalesce(get(o, "campaignName"), get(o, "campaign")), "campaignName", LIMIT_NAME)?;
    let party_override = optional_text(coalesce(get(o, "partyName"), get(o, "party")), "partyName", LIMIT_NAME)?;
    let campaign_name = if !campaign_override.is_empty() && campaign_override != "Новая кампания" {
        Value::String(campaign_override)
    } else if js::truthy(opening.get("campaignName")) {
        opening["campaignName"].clone()
    } else {
        template["name"].clone()
    };
    let party_name = if !party_override.is_empty() && party_override != "Новый отряд" {
        Value::String(party_override)
    } else if js::truthy(opening.get("partyName")) {
        opening["partyName"].clone()
    } else {
        Value::String("Новый отряд".into())
    };
    let mut scene = opening["scene"].clone();
    let locations = template["world_map"]["locations"].as_array().map(Vec::as_slice).unwrap_or_default();
    let found = locations.iter().find(|location| location.get("id") == scene.get("locationId"));
    if let Value::Object(map) = &mut scene {
        if let Some(location_id) = found.and_then(|location| coalesce(location.get("id"), None)) {
            map.insert("locationId".into(), location_id.clone());
        }
        let location_id = map.get("locationId").cloned().unwrap_or(Value::Null);
        map.insert("location_id".into(), location_id.clone());
        let by_id = locations.iter().find(|location| location.get("id") == Some(&location_id));
        if let Some(name) = by_id.and_then(|location| coalesce(location.get("name"), None)) {
            map.insert("location".into(), name.clone());
        }
    }
    let world_rules = if is_nullish(opening.get("world_rules")) { None } else { opening.get("world_rules").cloned() };
    let mut out = json!({
        "campaignName": campaign_name,
        "partyName": party_name,
        "worldSummary": opening["worldSummary"],
        "worldHistory": opening["worldHistory"],
        "worldMap": template["world_map"],
        "openingNarration": opening["openingNarration"],
        "scene": scene,
        "hook": opening["hook"],
        "npcs": opening["npcs"],
        "secrets": coalesce(opening.get("secrets"), None).cloned().unwrap_or_else(|| json!([])),
    });
    if let (Some(rules), Value::Object(map)) = (world_rules, &mut out) {
        map.insert("worldRules".into(), rules.clone());
        map.insert("world_rules".into(), rules);
    }
    Ok(out)
}

/// `worldTemplateConcept(template)`: концепт мира для создания кампании.
pub fn world_template_concept(template_value: Option<&Value>) -> R<Value> {
    let template = template_for(template_value)?;
    let opening = world_template_opening(Some(template), &json!({}))?;
    let mut out = match &template["world"] {
        Value::Object(map) => spread(map),
        _ => Map::new(),
    };
    let version = version_label(&template["version"]);
    out.insert("worldSummary".into(), opening["worldSummary"].clone());
    out.insert("worldHistory".into(), opening["worldHistory"].clone());
    out.insert("world_template_id".into(), template["id"].clone());
    out.insert("world_template_version".into(), Value::String(version.clone()));
    out.insert(
        "template".into(),
        json!({
            "id": template["id"], "version": version, "name": template["name"], "tagline": template["tagline"],
            "description": template["description"], "image": template["image"], "imageAlt": template["imageAlt"],
            "accent": template["accent"], "focus": template["focus"], "recommendedLevels": template["recommendedLevels"],
        }),
    );
    for key in ["histories", "storyHooks", "timeline", "factions", "story_arcs"] {
        out.insert(key.into(), template[key].clone());
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Урок 7: опечатка в ключевом поле копии каталога — отказ, который
    /// называет файл и шаблон.
    #[test]
    fn broken_copy_names_file_and_template() {
        assert_eq!(check_world_template_catalog(), Ok(()));
        assert!(parse_world_template_catalog(CATALOG_TEXT, &|_| true).is_ok());
        let mut raw: Value = serde_json::from_str(CATALOG_TEXT).expect("каталог");
        let template = raw["templates"][2].as_object_mut().expect("шаблон");
        let id = template.shift_remove("id").expect("id");
        template.insert("idd".into(), id);
        let error = parse_world_template_catalog(&raw.to_string(), &|_| true).err().map(|error| error.to_string());
        assert!(error.as_deref().is_some_and(|text| text.starts_with("data/campaign-worlds-v1.json: ") && text.contains("templates[2]")), "{error:?}");
    }
}

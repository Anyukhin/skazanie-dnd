//! Перенос `server/world-map.mjs` — глобальная карта кампании.
//!
//! Карта собирается детерминированно из сида: процедурные регионы и места
//! (генератор — sha256 сида и линейный конгруэнтный шаг, как в JS), авторские
//! данные кампании поверх них, дороги между ближайшими местами. Сверка
//! (`reconcileWorldMap`) добавляет места из хроники рядом с предыдущей точкой и
//! соединяет новую сцену дорогой с прошлой.
//!
//! Карта — JSON той же формы и с тем же порядком полей, что у JS. `null`
//! вместо концепта, источника, сцены и не-список мест хроники читаются как
//! пропущенное поле (старые сохранения).

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::fancy_regex::Regex;
use sk_core::{js, re, text as sk_text};

use crate::js_extra::{
    collapse_js_whitespace, js_hypot, js_max, js_min, js_string, js_string_or_empty, js_trim, slice_utf16, utf16_cmp,
};

const WIDTH: f64 = 1000.0;
const HEIGHT: f64 = 640.0;
const KINDS: [&str; 10] = ["capital", "city", "town", "village", "port", "fortress", "ruin", "dungeon", "landmark", "wilds"];
/// Биомы регионов карты мира. В JS константа не экспортируется — тест погоды
/// (`test/weather.test.mjs`) сверяет с ней таблицу климата, разбирая исходник;
/// здесь она открыта, чтобы перенос погоды сверялся с ней напрямую.
pub const BIOMES: [&str; 8] = ["plains", "forest", "mountains", "marsh", "desert", "tundra", "coast", "wastes"];
const ROUTE_KINDS: [&str; 5] = ["road", "trail", "river", "sea", "pass"];
const WORLD_MAP_BACKGROUND_MAX_LENGTH: usize = 180;
const WORLD_MAP_BACKGROUND_ALT_MAX_LENGTH: usize = 240;
const LOCATION_HISTORY_MAX_LENGTH: usize = 1_200;
const LOCATION_STORY_HOOK_LIMIT: usize = 3;
const LOCATION_STORY_HOOK_MAX_LENGTH: usize = 320;
const CITY_OVERVIEW_TEXT_MAX_LENGTH: usize = 1_200;
const CITY_OVERVIEW_DISTRICT_LIMIT: usize = 8;
const CITY_OVERVIEW_PLACE_LIMIT: usize = 12;
const CITY_OVERVIEW_PLACE_KINDS: [&str; 12] =
    ["civic", "harbor", "market", "temple", "archive", "gate", "tower", "garden", "workshop", "infrastructure", "inn", "other"];
const ROUTE_DANGERS: [&str; 3] = ["низкая", "средняя", "высокая"];
const STARTING_SUMMARY: &str = "Здесь начинается история отряда.";

/// Источник `WORLD_MAP_BACKGROUND_URL_RE` (флаг `u`). Фон карты — только
/// заранее зарегистрированный ассет репозитория: полный URL, query string и
/// фрагменты не проходят, чтобы SVG не стал каналом загрузки внешнего ресурса.
pub const WORLD_MAP_BACKGROUND_URL_PATTERN: &str = r"^\/assets\/maps\/world\/skazanie\/[a-z0-9-]+-v[1-9][0-9]*\.webp$";
/// Источник `CITY_OVERVIEW_IMAGE_URL_RE` (флаг `u`).
pub const CITY_OVERVIEW_IMAGE_URL_PATTERN: &str = r"^\/assets\/maps\/city\/skazanie\/[a-z0-9-]+-v[1-9][0-9]*\.webp$";

/// `WORLD_MAP_BACKGROUND_URL_RE`.
pub static WORLD_MAP_BACKGROUND_URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    sk_text::js_regex(WORLD_MAP_BACKGROUND_URL_PATTERN, "u").expect("постоянное регулярное выражение фона карты")
});
/// `CITY_OVERVIEW_IMAGE_URL_RE`.
pub static CITY_OVERVIEW_IMAGE_URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    sk_text::js_regex(CITY_OVERVIEW_IMAGE_URL_PATTERN, "u").expect("постоянное регулярное выражение плана города")
});

// ---------------------------------------------------------------------------
// Текст и числа, как в JS.

/// `text(value, maximum)` для уже приведённой строки: NFKC, пробелы `\s+` в
/// один, `trim`, срез по UTF-16.
fn text_str(raw: &str, maximum: usize) -> String {
    let collapsed = collapse_js_whitespace(&sk_text::nfkc(raw));
    slice_utf16(js_trim(&collapsed), maximum)
}

/// `text(value, maximum)`: `String(value ?? '')` → [`text_str`].
fn text(value: Option<&Value>, maximum: usize) -> String {
    text_str(&js_string_or_empty(value), maximum)
}

/// `stringText(value, maximum)`: только строки.
fn string_text(value: Option<&Value>, maximum: usize) -> String {
    match value {
        Some(Value::String(raw)) => text_str(raw, maximum),
        _ => String::new(),
    }
}

/// `key(value)`: `text(value, 180).toLowerCase()`.
fn key(value: Option<&Value>) -> String {
    sk_text::lower(&text(value, 180))
}

fn key_str(raw: &str) -> String {
    sk_text::lower(&text_str(raw, 180))
}

/// `number(value, fallback, minimum, maximum)` для уже приведённого числа:
/// конечное — округлить и ограничить, иначе запас (без ограничения).
fn clamp_number(parsed: f64, fallback: f64, minimum: f64, maximum: f64) -> f64 {
    if parsed.is_finite() {
        js_max(minimum, js_min(maximum, js::round(parsed)))
    } else {
        fallback
    }
}

/// `number(value, fallback, minimum, maximum)`: `Number(value)` → [`clamp_number`].
fn number(value: Option<&Value>, fallback: f64, minimum: f64, maximum: f64) -> f64 {
    clamp_number(js::number(value), fallback, minimum, maximum)
}

/// `slug(value, fallback)` для уже приведённой строки.
fn slug_str(raw: &str, fallback: &str) -> String {
    let lowered = sk_text::lower(&text_str(raw, 120));
    let dashed = sk_text::replace_all(re!(r"[^a-zа-яё0-9]+", "giu"), &lowered, "-");
    let normalized = dashed.trim_matches('-');
    slice_utf16(if normalized.is_empty() { fallback } else { normalized }, 80)
}

/// `slug(value, fallback)`.
fn slug(value: Option<&Value>, fallback: &str) -> String {
    slug_str(&js_string_or_empty(value), fallback)
}

/// `hash(value)`: sha256 строки в hex.
fn hash(raw: &str) -> String {
    sk_core::hash::sha256_hex(raw)
}

/// `seededRandom(seed)`: первые четыре байта sha256 (little-endian, ноль
/// заменяется единицей) и шаг `state = state * 1664525 + 1013904223 mod 2³²`.
struct SeededRandom {
    state: u32,
}

impl SeededRandom {
    fn new(seed: &str) -> Self {
        let digest = sk_core::hash::sha256(seed);
        let state = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]);
        Self { state: if state == 0 { 1 } else { state } }
    }

    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(self.state) / 4_294_967_296.0
    }

    /// `list[Math.floor(random() * list.length)]`.
    fn pick<'a>(&mut self, list: &[&'a str]) -> &'a str {
        let index = (self.next() * list.len() as f64).floor() as usize;
        list[index.min(list.len() - 1)]
    }
}

/// `uniqueId(base, used)`: `base`, затем `base[..72]-2`, `-3`, …
fn unique_id(base: &str, used: &mut HashSet<String>) -> String {
    let mut id = base.to_string();
    let mut suffix = 2;
    while used.contains(&id) {
        id = format!("{}-{}", slice_utf16(base, 72), suffix);
        suffix += 1;
    }
    used.insert(id.clone());
    id
}

/// `[a, b].sort().join(':')` для двух строк.
fn pair_signature(first: &str, second: &str) -> String {
    let mut pair = [first, second];
    pair.sort_by(|left, right| utf16_cmp(left, right));
    pair.join(":")
}

fn get<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    value.as_object().and_then(|map| map.get(name))
}

/// Поле-строка записи карты (`location.id`, `region.name`); не строка — пусто.
fn str_field<'a>(value: &'a Value, name: &str) -> &'a str {
    get(value, name).and_then(Value::as_str).unwrap_or("")
}

/// Координата записи карты. Записи собраны модулем, там всегда числа.
fn coord(value: &Value, name: &str) -> f64 {
    get(value, name).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// Текст V8 для `fn({ seed, … } = {})`, вызванной с `null`.
const DESTRUCTURE_NULL_SEED: &str =
    "Cannot destructure property 'seed' of '(intermediate value)(intermediate value)(intermediate value)' as it is null.";

fn type_error_reading(property: &str) -> String {
    format!("Cannot read properties of null (reading '{property}')")
}

/// Первый элемент устойчивой сортировки по `Math.hypot(x - item.x, y - item.y)`
/// — то, что в JS даёт `[...items].sort(...)[0]`.
fn nearest_by_distance<'a>(items: impl IntoIterator<Item = &'a Value>, x: f64, y: f64) -> Option<&'a Value> {
    let mut best: Option<(&Value, f64)> = None;
    for item in items {
        let distance = js_hypot(x - coord(item, "x"), y - coord(item, "y"));
        match best {
            Some((_, best_distance)) if !(distance < best_distance) => {}
            _ => best = Some((item, distance)),
        }
    }
    best.map(|(item, _)| item)
}

// ---------------------------------------------------------------------------
// Фон, лор и городской обзор.

/// `safeWorldMapBackgroundUrl(value)` — путь фона, если он из реестра ассетов,
/// иначе пустая строка.
pub fn safe_world_map_background_url(value: Option<&Value>) -> String {
    let candidate = string_text(value, WORLD_MAP_BACKGROUND_MAX_LENGTH);
    if sk_text::test(&WORLD_MAP_BACKGROUND_URL_RE, &candidate) {
        candidate
    } else {
        String::new()
    }
}

/// `normalizeWorldMapBackground(value)` — `{ backgroundImage?, backgroundAlt? }`.
pub fn normalize_world_map_background(value: Option<&Value>) -> Value {
    Value::Object(world_map_background(value))
}

fn world_map_background(value: Option<&Value>) -> Map<String, Value> {
    let mut result = Map::new();
    let Some(source) = value.filter(|value| value.is_object()) else {
        return result;
    };
    let background_image = safe_world_map_background_url(get(source, "backgroundImage"));
    if background_image.is_empty() {
        return result;
    }
    let background_alt = string_text(get(source, "backgroundAlt"), WORLD_MAP_BACKGROUND_ALT_MAX_LENGTH);
    result.insert("backgroundImage".into(), Value::String(background_image));
    if !background_alt.is_empty() {
        result.insert("backgroundAlt".into(), Value::String(background_alt));
    }
    result
}

/// `storyHooks(value)`: до трёх непустых строк-зацепок.
fn story_hooks(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .map(|entry| string_text(Some(entry), LOCATION_STORY_HOOK_MAX_LENGTH))
        .filter(|entry| !entry.is_empty())
        .take(LOCATION_STORY_HOOK_LIMIT)
        .collect()
}

/// `locationLore(raw)` / `cityOverviewLore(raw)`: `{ history?, storyHooks? }`.
fn location_lore(raw: &Value) -> Map<String, Value> {
    let mut lore = Map::new();
    let history = string_text(get(raw, "history"), LOCATION_HISTORY_MAX_LENGTH);
    let hooks = story_hooks(get(raw, "storyHooks"));
    if !history.is_empty() {
        lore.insert("history".into(), Value::String(history));
    }
    if !hooks.is_empty() {
        lore.insert("storyHooks".into(), json!(hooks));
    }
    lore
}

/// `normalizeWorldMapLocationLore(value)` — лор точки на границах авторской
/// карты и проекции игрока: `{ history?, storyHooks? }`.
pub fn normalize_world_map_location_lore(value: Option<&Value>) -> Value {
    match value {
        Some(raw @ Value::Object(_)) => Value::Object(location_lore(raw)),
        _ => Value::Object(Map::new()),
    }
}

/// `safeCityOverviewId(value)`.
fn safe_city_overview_id(value: Option<&Value>) -> String {
    let candidate = string_text(value, 80);
    if sk_text::test(re!(r"^[a-z0-9][a-z0-9-]{0,79}$", "u"), &candidate) {
        candidate
    } else {
        String::new()
    }
}

/// `safeCityOverviewImageUrl(value)` — путь плана города из реестра ассетов
/// или пустая строка.
pub fn safe_city_overview_image_url(value: Option<&Value>) -> String {
    let candidate = string_text(value, 180);
    if sk_text::test(&CITY_OVERVIEW_IMAGE_URL_RE, &candidate) {
        candidate
    } else {
        String::new()
    }
}

/// `a ?? b` для полей JSON.
fn coalesce<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        None | Some(Value::Null) => second,
        value => value,
    }
}

/// `a || b` для полей JSON.
fn or_else<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    if js::truthy(first) {
        first
    } else {
        second
    }
}

/// `normalizeCityOverview(value)` — городской обзор, только презентационная
/// структура: в нём нет расстояний, опасности, текущей позиции или команды
/// перехода. `None` (`null` в JS), если нет картинки, имени, описания, районов
/// или мест.
pub fn normalize_city_overview(value: Option<&Value>) -> Option<Value> {
    let source = value.filter(|value| value.is_object())?;
    let image = safe_city_overview_image_url(get(source, "image"));
    let name = string_text(get(source, "name"), 160);
    let summary = string_text(get(source, "summary"), CITY_OVERVIEW_TEXT_MAX_LENGTH);
    if image.is_empty() || name.is_empty() || summary.is_empty() {
        return None;
    }
    let width = number(get(source, "width"), WIDTH, 320.0, 2_000.0);
    let height = number(get(source, "height"), HEIGHT, 240.0, 1_200.0);

    let mut district_ids: HashSet<String> = HashSet::new();
    let mut districts = Vec::new();
    let raw_districts = get(source, "districts").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    for raw in raw_districts.iter().take(CITY_OVERVIEW_DISTRICT_LIMIT) {
        if !raw.is_object() {
            continue;
        }
        let id = safe_city_overview_id(get(raw, "id"));
        let district_name = string_text(get(raw, "name"), 120);
        if id.is_empty() || district_name.is_empty() || district_ids.contains(&id) {
            continue;
        }
        district_ids.insert(id.clone());
        let x = number(get(raw, "x"), width / 2.0, 35.0, width - 35.0);
        let y = number(get(raw, "y"), height / 2.0, 35.0, height - 35.0);
        let empty = json!({});
        let raw_bounds = get(raw, "bounds").filter(|bounds| bounds.is_object()).unwrap_or(&empty);
        let bounds_x = number(get(raw_bounds, "x"), js_max(20.0, x - 90.0), 20.0, width - 80.0);
        let bounds_y = number(get(raw_bounds, "y"), js_max(20.0, y - 70.0), 20.0, height - 80.0);
        let bounds_width = number(get(raw_bounds, "width"), 180.0, 80.0, js_max(80.0, width - bounds_x - 20.0));
        let bounds_height = number(get(raw_bounds, "height"), 140.0, 80.0, js_max(80.0, height - bounds_y - 20.0));
        let mut district = Map::new();
        district.insert("id".into(), Value::String(id));
        district.insert("name".into(), Value::String(district_name));
        district.insert("x".into(), js::num(x));
        district.insert("y".into(), js::num(y));
        district.insert(
            "bounds".into(),
            json!({ "x": js::num(bounds_x), "y": js::num(bounds_y), "width": js::num(bounds_width), "height": js::num(bounds_height) }),
        );
        district.insert("summary".into(), Value::String(string_text(get(raw, "summary"), 500)));
        district.extend(location_lore(raw));
        districts.push(Value::Object(district));
    }
    if districts.is_empty() {
        return None;
    }

    let mut place_ids: HashSet<String> = HashSet::new();
    let mut places = Vec::new();
    let raw_places = get(source, "places").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    for raw in raw_places.iter().take(CITY_OVERVIEW_PLACE_LIMIT) {
        if !raw.is_object() {
            continue;
        }
        let id = safe_city_overview_id(get(raw, "id"));
        let place_name = string_text(get(raw, "name"), 120);
        let district_id = safe_city_overview_id(coalesce(get(raw, "districtId"), get(raw, "district_id")));
        if id.is_empty() || place_name.is_empty() || !district_ids.contains(&district_id) || place_ids.contains(&id) {
            continue;
        }
        place_ids.insert(id.clone());
        let kind = match get(raw, "kind") {
            Some(Value::String(kind)) if CITY_OVERVIEW_PLACE_KINDS.contains(&kind.as_str()) => kind.clone(),
            _ => "other".into(),
        };
        let mut place = Map::new();
        place.insert("id".into(), Value::String(id));
        place.insert("name".into(), Value::String(place_name));
        place.insert("kind".into(), Value::String(kind));
        place.insert("districtId".into(), Value::String(district_id));
        place.insert("x".into(), js::num(number(get(raw, "x"), width / 2.0, 25.0, width - 25.0)));
        place.insert("y".into(), js::num(number(get(raw, "y"), height / 2.0, 25.0, height - 25.0)));
        place.insert("summary".into(), Value::String(string_text(get(raw, "summary"), 500)));
        place.extend(location_lore(raw));
        places.push(Value::Object(place));
    }
    if places.is_empty() {
        return None;
    }
    let image_alt = string_text(coalesce(get(source, "imageAlt"), get(source, "image_alt")), 300);
    let mut overview = Map::new();
    overview.insert("version".into(), js::num(number(get(source, "version"), 1.0, 1.0, 99.0)));
    overview.insert("name".into(), Value::String(name));
    overview.insert("summary".into(), Value::String(summary));
    overview.insert("image".into(), Value::String(image));
    if !image_alt.is_empty() {
        overview.insert("imageAlt".into(), Value::String(image_alt));
    }
    overview.insert("width".into(), js::num(width));
    overview.insert("height".into(), js::num(height));
    overview.insert("districts".into(), Value::Array(districts));
    overview.insert("places".into(), Value::Array(places));
    Some(Value::Object(overview))
}

// ---------------------------------------------------------------------------
// Процедурная основа: регионы, места, дороги.

fn generated_place_name(random: &mut SeededRandom, kind: &str) -> String {
    let starts = ["Айр", "Валь", "Эл", "Нор", "Кер", "Тар", "Рун", "Мор", "Силь", "Эст", "Дор", "Каль"];
    let ends: &[&str] = match kind {
        "wilds" => &["ская чаща", "ские топи", "ская пустошь", "ские равнины"],
        "ruin" | "dungeon" => &["ские руины", "ский курган", "ская башня", "ский склеп"],
        "fortress" => &["ская твердыня", "ский дозор", "ская цитадель"],
        _ => &["хольм", "вуд", "гард", "мир", "форд", "мар", "вель"],
    };
    let start = random.pick(&starts);
    let end = random.pick(ends);
    format!("{start}{end}")
}

fn generated_region_name(random: &mut SeededRandom, biome: &str) -> String {
    let adjectives = ["Серебряные", "Пепельные", "Туманные", "Зелёные", "Сумеречные", "Северные", "Забытые", "Багряные"];
    let nouns: &[&str] = match biome {
        "mountains" => &["Пределы", "Кряжи", "Высоты"],
        "forest" => &["Леса", "Чащи", "Пущи"],
        "coast" => &["Берега", "Побережья", "Фьорды"],
        "marsh" => &["Низины", "Топи", "Плавни"],
        _ => &["Земли", "Долины", "Равнины"],
    };
    let adjective = random.pick(&adjectives);
    let noun = random.pick(nouns);
    format!("{adjective} {noun}")
}

/// `${concept.<name> ?? ''}`.
fn concept_part(concept: &Value, name: &str) -> String {
    js_string_or_empty(get(concept, name))
}

fn fallback_regions(seed: &str, concept: &Value) -> Result<Vec<Value>, String> {
    let mut random = SeededRandom::new(&format!("{seed}:regions"));
    let signature = sk_text::lower(&format!(
        "{} {} {}",
        concept_part(concept, "preset"),
        concept_part(concept, "genre"),
        concept_part(concept, "worldSummary")
    ));
    let arid = sk_text::test(re!(r"пустын|пустош|постапок", "iu"), &signature);
    let cold = sk_text::test(re!(r"лед|север|тундр|арктик", "iu"), &signature);
    let biomes = if arid {
        ["wastes", "desert", "mountains", "plains", "coast"]
    } else if cold {
        ["tundra", "mountains", "forest", "plains", "coast"]
    } else {
        ["forest", "mountains", "plains", "marsh", "coast"]
    };
    let centers = [(235.0, 185.0), (760.0, 155.0), (515.0, 330.0), (225.0, 495.0), (785.0, 485.0)];
    Ok(centers
        .iter()
        .enumerate()
        .map(|(index, (x, y))| {
            let name = generated_region_name(&mut random, biomes[index]);
            let x = x + js::round((random.next() - 0.5) * 55.0);
            let y = y + js::round((random.next() - 0.5) * 42.0);
            json!({
                "id": format!("region-{}", index + 1),
                "name": name,
                "biome": biomes[index],
                "x": js::num(x),
                "y": js::num(y),
                "radius": if index == 2 { 245 } else { 205 },
            })
        })
        .collect())
}

fn fallback_locations(seed: &str, starting_location: &Value, regions: &[Value]) -> Vec<Value> {
    let mut random = SeededRandom::new(&format!("{seed}:locations"));
    let positions = [
        (500.0, 360.0),
        (300.0, 280.0),
        (690.0, 270.0),
        (170.0, 450.0),
        (830.0, 440.0),
        (410.0, 125.0),
        (625.0, 510.0),
        (845.0, 130.0),
        (125.0, 145.0),
    ];
    let kinds = ["town", "village", "city", "wilds", "fortress", "ruin", "port", "dungeon", "landmark"];
    let start_name = text(Some(starting_location), 180);
    positions
        .iter()
        .enumerate()
        .map(|(index, (base_x, base_y))| {
            let x = base_x + js::round((random.next() - 0.5) * 60.0);
            let y = base_y + js::round((random.next() - 0.5) * 46.0);
            let nearest = nearest_by_distance(regions, x, y);
            let name = if index == 0 && !start_name.is_empty() {
                start_name.clone()
            } else {
                generated_place_name(&mut random, kinds[index])
            };
            // `nearest?.id ?? regions[0]?.id ?? ''`.
            let region_id = [nearest, regions.first()]
                .into_iter()
                .flatten()
                .filter_map(|region| get(region, "id").filter(|id| !id.is_null()))
                .next()
                .cloned()
                .unwrap_or_else(|| json!(""));
            let summary = if index == 0 {
                STARTING_SUMMARY.to_string()
            } else {
                let region_name = nearest
                    .and_then(|region| get(region, "name"))
                    .filter(|name| !name.is_null())
                    .map_or_else(|| "Неизведанные земли".to_string(), |name| js_string(Some(name)));
                format!("Известное место региона «{region_name}».")
            };
            json!({
                "id": format!("location-{}-{}", index + 1, slug_str(&name, "place")),
                "name": name,
                "kind": kinds[index],
                "x": js::num(x),
                "y": js::num(y),
                "regionId": region_id,
                "summary": summary,
                "known": true,
                "visited": index == 0,
            })
        })
        .collect()
}

fn route_value(id: String, from: &str, to: &str, kind: Value, distance: f64, danger: Value, discovered: bool) -> Value {
    json!({
        "id": id,
        "from": from,
        "to": to,
        "kind": kind,
        "distance": js::num(distance),
        "danger": danger,
        "discovered": discovered,
    })
}

/// `Math.max(1, Math.round(Math.hypot(dx, dy) / 48))` — дорога в днях пути.
fn travel_distance(from: &Value, to: &Value) -> f64 {
    js_max(1.0, js::round(js_hypot(coord(from, "x") - coord(to, "x"), coord(from, "y") - coord(to, "y")) / 48.0))
}

fn fallback_routes(locations: &[Value]) -> Vec<Value> {
    let mut sorted: Vec<&Value> = locations.iter().collect();
    sorted.sort_by(|left, right| (coord(left, "x") - coord(right, "x")).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut pairs: Vec<(&Value, &Value)> = Vec::new();
    for index in 1..sorted.len() {
        pairs.push((sorted[index - 1], sorted[index]));
    }
    for location in locations {
        let id = str_field(location, "id");
        let nearest = nearest_by_distance(
            locations.iter().filter(|candidate| str_field(candidate, "id") != id),
            coord(location, "x"),
            coord(location, "y"),
        );
        if let Some(nearest) = nearest {
            pairs.push((location, nearest));
        }
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut routes = Vec::new();
    for (index, (from, to)) in pairs.into_iter().enumerate() {
        let signature = pair_signature(str_field(from, "id"), str_field(to, "id"));
        if !seen.insert(signature.clone()) {
            continue;
        }
        let distance = travel_distance(from, to);
        routes.push(route_value(
            format!("route-{}-{}", index + 1, &hash(&signature)[..8]),
            str_field(from, "id"),
            str_field(to, "id"),
            json!("road"),
            distance,
            json!(if distance > 7.0 { "средняя" } else { "низкая" }),
            true,
        ));
    }
    routes
}

fn normalize_regions(raw_regions: Option<&Value>, fallback: &[Value]) -> Vec<Value> {
    let mut used: HashSet<String> = HashSet::new();
    let mut regions = Vec::new();
    let raw_list = raw_regions.and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    for (index, raw) in raw_list.iter().take(12).enumerate() {
        if !raw.is_object() {
            continue;
        }
        let name = text(get(raw, "name"), 100);
        if name.is_empty() {
            continue;
        }
        let base = match get(raw, "id") {
            id if js::truthy(id) => slug(id, &format!("region-{}", index + 1)),
            _ => slug_str(&name, &format!("region-{}", index + 1)),
        };
        let fallback_entry = &fallback[index % fallback.len()];
        let biome = match get(raw, "biome") {
            Some(Value::String(biome)) if BIOMES.contains(&biome.as_str()) => json!(biome),
            _ => coalesce(get(fallback_entry, "biome"), None).cloned().unwrap_or_else(|| json!("plains")),
        };
        let fallback_x = get(fallback_entry, "x").filter(|x| !x.is_null()).map_or(WIDTH / 2.0, |x| js::number(Some(x)));
        let fallback_y = get(fallback_entry, "y").filter(|y| !y.is_null()).map_or(HEIGHT / 2.0, |y| js::number(Some(y)));
        let id = unique_id(&base, &mut used);
        regions.push(json!({
            "id": id,
            "name": name,
            "biome": biome,
            "x": js::num(number(get(raw, "x"), fallback_x, 60.0, WIDTH - 60.0)),
            "y": js::num(number(get(raw, "y"), fallback_y, 55.0, HEIGHT - 55.0)),
            "radius": js::num(number(get(raw, "radius"), 205.0, 120.0, 300.0)),
        }));
    }
    if regions.len() >= 3 {
        regions
    } else {
        fallback.to_vec()
    }
}

fn nearest_region_id(regions: &[Value], x: f64, y: f64) -> Value {
    nearest_by_distance(regions, x, y)
        .and_then(|region| get(region, "id"))
        .filter(|id| !id.is_null())
        .cloned()
        .unwrap_or_else(|| json!(""))
}

fn normalize_locations(
    raw_locations: Option<&Value>,
    fallback: &[Value],
    regions: &[Value],
    current_location: &Value,
    current_location_id: &Value,
) -> Vec<Value> {
    let mut used: HashSet<String> = HashSet::new();
    let mut region_by_name: HashMap<String, Value> = HashMap::new();
    for region in regions {
        region_by_name.insert(key(get(region, "name")), get(region, "id").cloned().unwrap_or(Value::Null));
    }
    let source: &[Value] = match raw_locations {
        Some(Value::Array(items)) if !items.is_empty() => items,
        _ => fallback,
    };
    let current_id = text(Some(current_location_id), 120);
    let current_key = key(Some(current_location));
    let mut locations = Vec::new();
    for (index, raw) in source.iter().take(40).enumerate() {
        if !raw.is_object() {
            continue;
        }
        let name = text(get(raw, "name"), 120);
        if name.is_empty() {
            continue;
        }
        let fallback_entry = &fallback[index % fallback.len()];
        let fallback_x = get(fallback_entry, "x").filter(|x| !x.is_null()).map_or(WIDTH / 2.0, |x| js::number(Some(x)));
        let fallback_y = get(fallback_entry, "y").filter(|y| !y.is_null()).map_or(HEIGHT / 2.0, |y| js::number(Some(y)));
        let x = number(get(raw, "x"), fallback_x, 45.0, WIDTH - 45.0);
        let y = number(get(raw, "y"), fallback_y, 45.0, HEIGHT - 45.0);
        let raw_region_id = get(raw, "regionId");
        let region_id = if regions.iter().any(|region| strict_equal(get(region, "id"), raw_region_id)) {
            raw_region_id.cloned().unwrap_or(Value::Null)
        } else {
            match region_by_name.get(&key(get(raw, "region"))) {
                Some(id) if !id.is_null() => id.clone(),
                _ => nearest_region_id(regions, x, y),
            }
        };
        let id = unique_id(
            &match get(raw, "id") {
                id if js::truthy(id) => slug(id, &format!("location-{}", index + 1)),
                _ => slug_str(&name, &format!("location-{}", index + 1)),
            },
            &mut used,
        );
        let city_overview = normalize_city_overview(coalesce(get(raw, "cityOverview"), get(raw, "city_overview")));
        let kind = match get(raw, "kind") {
            Some(Value::String(kind)) if KINDS.contains(&kind.as_str()) => kind.clone(),
            _ => "landmark".into(),
        };
        let visited = matches!(get(raw, "visited"), Some(Value::Bool(true))) || id == current_id || key_str(&name) == current_key;
        let mut location = Map::new();
        location.insert("id".into(), Value::String(id));
        location.insert("name".into(), Value::String(name));
        location.insert("kind".into(), Value::String(kind));
        location.insert("x".into(), js::num(x));
        location.insert("y".into(), js::num(y));
        location.insert("regionId".into(), region_id);
        location.insert("summary".into(), Value::String(text(or_else(get(raw, "summary"), get(raw, "description")), 320)));
        location.extend(location_lore(raw));
        if let Some(city_overview) = city_overview {
            location.insert("cityOverview".into(), city_overview);
        }
        // Место без гарнизона: укрепление есть, а стражи нет — заброшенный
        // замок, башня одинокого мага. Закон туда не приходит.
        if matches!(get(raw, "garrison"), Some(Value::Bool(false))) {
            location.insert("garrison".into(), Value::Bool(false));
        }
        location.insert("known".into(), Value::Bool(!matches!(get(raw, "known"), Some(Value::Bool(false)))));
        location.insert("visited".into(), Value::Bool(visited));
        locations.push(Value::Object(location));
    }
    locations
}

/// `a === b` для значений JSON (`undefined` — `None`).
fn strict_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Number(left)), Some(Value::Number(right))) => left.as_f64() == right.as_f64(),
        (Some(left @ (Value::Null | Value::Bool(_) | Value::String(_))), Some(right)) => left == right,
        // Объекты и массивы равны только сами себе — из JSON таких нет.
        _ => false,
    }
}

fn location_by_id(locations: &[Value], location_id: Option<&Value>) -> Option<usize> {
    let expected = text(location_id, 120);
    if expected.is_empty() {
        return None;
    }
    locations.iter().position(|location| get(location, "id").and_then(Value::as_str) == Some(expected.as_str()))
}

/// `worldLocationById(map, locationId)` — место карты по идентификатору.
///
/// `location_id` — уже `String(locationId ?? '')`; к нему применяется та же
/// нормализация, что в JS (NFKC, пробелы, 120 символов). Не-объект среди мест
/// (`null` старого сохранения) пропускается, как в JS.
pub fn world_location_by_id<'a>(map: Option<&'a Value>, location_id: &str) -> Option<&'a Value> {
    let locations = map.and_then(|map| get(map, "locations")).and_then(Value::as_array)?;
    let expected = text_str(location_id, 120);
    if expected.is_empty() {
        return None;
    }
    locations.iter().find(|location| get(location, "id").and_then(Value::as_str) == Some(expected.as_str()))
}

fn endpoint_id(value: Option<&Value>, locations: &[Value], names: &[String]) -> String {
    let expected = key(value);
    locations
        .iter()
        .zip(names)
        .find(|(location, name)| strict_equal(get(location, "id"), value) || **name == expected)
        .map(|(location, _)| str_field(location, "id").to_string())
        .unwrap_or_default()
}

fn normalize_routes(raw_routes: &[Value], fallback: &[Value], locations: &[Value]) -> Vec<Value> {
    let source = if raw_routes.is_empty() { fallback } else { raw_routes };
    // Имена мест неизменны в пределах сборки сети: нормализуются один раз.
    let names: Vec<String> = locations.iter().map(|location| key(get(location, "name"))).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut routes = Vec::new();
    for (index, raw) in source.iter().take(80).enumerate() {
        let from = endpoint_id(get(raw, "from"), locations, &names);
        let to = endpoint_id(get(raw, "to"), locations, &names);
        let signature = pair_signature(&from, &to);
        if from.is_empty() || to.is_empty() || from == to || seen.contains(&signature) {
            continue;
        }
        seen.insert(signature.clone());
        let by_id = |id: &str| locations.iter().find(|location| str_field(location, "id") == id);
        let (Some(from_node), Some(to_node)) = (by_id(&from), by_id(&to)) else { continue };
        let estimated = travel_distance(from_node, to_node);
        let id = match text(get(raw, "id"), 100) {
            id if !id.is_empty() => id,
            _ => format!("route-{}-{}", index + 1, &hash(&signature)[..8]),
        };
        let kind = match get(raw, "kind") {
            Some(Value::String(kind)) if ROUTE_KINDS.contains(&kind.as_str()) => json!(kind),
            _ => json!("road"),
        };
        let danger = match get(raw, "danger") {
            Some(Value::String(danger)) if ROUTE_DANGERS.contains(&danger.as_str()) => json!(danger),
            _ => json!(if estimated > 7.0 { "средняя" } else { "низкая" }),
        };
        routes.push(route_value(
            id,
            &from,
            &to,
            kind,
            number(get(raw, "distance"), estimated, 1.0, 30.0),
            danger,
            !matches!(get(raw, "discovered"), Some(Value::Bool(false))),
        ));
    }
    routes
}

// ---------------------------------------------------------------------------
// Сборка и сверка карты.

/// Разобранные параметры `createCampaignWorldMap` после значений по
/// умолчанию.
struct CreateArgs<'a> {
    seed: Option<&'a Value>,
    /// Без значения по умолчанию: `undefined` в шаблоне — `"undefined"`.
    campaign_name: Option<&'a Value>,
    concept: &'a Value,
    source: &'a Value,
    starting_location: &'a Value,
    starting_location_id: &'a Value,
    add_missing_starting_location: bool,
}

static EMPTY_OBJECT: LazyLock<Value> = LazyLock::new(|| json!({}));
static EMPTY_STRING: LazyLock<Value> = LazyLock::new(|| json!(""));
static EMPTY_ARRAY: LazyLock<Value> = LazyLock::new(|| json!([]));

fn create_map(args: &CreateArgs) -> Result<Value, String> {
    let seed_text = text(args.seed, 120);
    let safe_seed = if seed_text.is_empty() {
        hash(&format!("{}:{}", js_string(args.campaign_name), js_string(Some(args.starting_location))))[..24].to_string()
    } else {
        seed_text
    };
    // `concept ??= {}`, `source ??= {}`: `null` старого сохранения — пустой объект.
    let concept = if args.concept.is_null() { &*EMPTY_OBJECT } else { args.concept };
    let region_fallback = fallback_regions(&safe_seed, concept)?;
    let source = if args.source.is_null() { &*EMPTY_OBJECT } else { args.source };
    let regions = normalize_regions(get(source, "regions"), &region_fallback);
    let location_fallback = fallback_locations(&safe_seed, args.starting_location, &regions);
    let mut locations =
        normalize_locations(get(source, "locations"), &location_fallback, &regions, args.starting_location, args.starting_location_id);
    // Авторская карта может не согласоваться с авторской же стартовой сценой.
    // Первая произвольная точка не имеет права молча стать currentLocationId:
    // выбранное место сцены сохраняется отдельным каноническим узлом. Явный id
    // сильнее имени и остаётся путём совместимости для сохранённых карт.
    let requested_by_id = location_by_id(&locations, Some(args.starting_location_id));
    let start_name = text(Some(args.starting_location), 120);
    if args.add_missing_starting_location
        && requested_by_id.is_none()
        && !start_name.is_empty()
        && !locations.iter().any(|location| key(get(location, "name")) == key_str(&start_name))
    {
        let fallback_start = &location_fallback[0];
        if locations.len() >= 40 {
            locations.truncate(39);
        }
        let mut used: HashSet<String> = locations.iter().map(|location| str_field(location, "id").to_string()).collect();
        let x = coord(fallback_start, "x");
        let y = coord(fallback_start, "y");
        let region_id = match get(fallback_start, "regionId") {
            id if js::truthy(id) => id.cloned().unwrap_or(Value::Null),
            _ => nearest_region_id(&regions, x, y),
        };
        locations.push(json!({
            "id": unique_id(&slug_str(&start_name, "starting-location"), &mut used),
            "name": start_name,
            "kind": "landmark",
            "x": js::num(x),
            "y": js::num(y),
            "regionId": region_id,
            "summary": STARTING_SUMMARY,
            "known": true,
            "visited": true,
        }));
    }
    let route_fallback = fallback_routes(&locations);
    // Полностью авторская сеть уже прошла отдельную проверку связности
    // каталога: её нельзя молча дополнять процедурными дорогами.
    let authored_routes = get(source, "routes").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let routes_complete = matches!(get(source, "routesComplete"), Some(Value::Bool(true))) && !authored_routes.is_empty();
    let route_source: Vec<Value> = if routes_complete {
        authored_routes.to_vec()
    } else {
        authored_routes.iter().chain(&route_fallback).cloned().collect()
    };
    let routes = normalize_routes(&route_source, &route_fallback, &locations);
    let starting_key = key(Some(args.starting_location));
    let current = location_by_id(&locations, Some(args.starting_location_id))
        .or_else(|| locations.iter().position(|location| key(get(location, "name")) == starting_key))
        .or(if locations.is_empty() { None } else { Some(0) });
    if let Some(index) = current {
        set_field(&mut locations[index], "visited", Value::Bool(true));
    }
    let current_location_id = current.map(|index| get(&locations[index], "id").cloned().unwrap_or(Value::Null)).unwrap_or_else(|| json!(""));
    let name = match text(get(source, "name"), 120) {
        name if !name.is_empty() => name,
        _ => {
            let campaign = match text(args.campaign_name, 100) {
                campaign if !campaign.is_empty() => campaign,
                _ => "Безымянная кампания".into(),
            };
            format!("Карта мира «{campaign}»")
        }
    };
    let mut map = Map::new();
    map.insert("version".into(), json!(1));
    map.insert("seed".into(), Value::String(safe_seed));
    map.insert("name".into(), Value::String(name));
    map.insert("width".into(), js::num(WIDTH));
    map.insert("height".into(), js::num(HEIGHT));
    map.insert("currentLocationId".into(), current_location_id);
    if routes_complete {
        map.insert("routesComplete".into(), Value::Bool(true));
    }
    map.extend(world_map_background(Some(source)));
    map.insert("regions".into(), Value::Array(regions));
    map.insert("locations".into(), Value::Array(locations));
    map.insert("routes".into(), Value::Array(routes));
    Ok(Value::Object(map))
}

fn set_field(target: &mut Value, name: &str, value: Value) {
    if let Some(map) = target.as_object_mut() {
        map.insert(name.into(), value);
    }
}

/// Поле параметров с `undefined` → значение по умолчанию.
fn option<'a>(options: &'a Value, name: &str, default: &'a Value) -> &'a Value {
    get(options, name).unwrap_or(default)
}

/// `createCampaignWorldMap({ seed, campaignName, concept = {}, source = {},
/// startingLocation = '', startingLocationId = '',
/// addMissingStartingLocation = true })` — карта кампании из сида и
/// авторского источника. Отсутствующее поле и `null` — значение по умолчанию.
pub fn create_campaign_world_map(input: &Value) -> Result<Value, String> {
    if input.is_null() {
        return Err(DESTRUCTURE_NULL_SEED.into());
    }
    create_map(&CreateArgs {
        seed: get(input, "seed"),
        campaign_name: get(input, "campaignName"),
        concept: option(input, "concept", &EMPTY_OBJECT),
        source: option(input, "source", &EMPTY_OBJECT),
        starting_location: option(input, "startingLocation", &EMPTY_STRING),
        starting_location_id: option(input, "startingLocationId", &EMPTY_STRING),
        add_missing_starting_location: get(input, "addMissingStartingLocation").is_none_or(|flag| js::truthy(Some(flag))),
    })
}

/// Разобранные параметры `reconcileWorldMap` (`undefined` — `None`).
#[derive(Default)]
struct ReconcileArgs<'a> {
    seed: Option<&'a Value>,
    campaign_name: Option<&'a Value>,
    concept: Option<&'a Value>,
    current_location: Option<&'a Value>,
    current_location_id: Option<&'a Value>,
    previous_location: Option<&'a Value>,
    previous_location_id: Option<&'a Value>,
    known_locations: Option<&'a Value>,
    transition: Option<&'a Value>,
    scene: Option<&'a Value>,
}

/// `freePosition(map, name, anchor)`: до 24 попыток на кольце 105–225 вокруг
/// anchor не ближе 68 к другим местам, иначе фиксированный сдвиг.
fn free_position(seed: &str, locations: &[Value], name: &str, anchor_x: f64, anchor_y: f64) -> (f64, f64) {
    let mut random = SeededRandom::new(&format!("{seed}:place:{name}"));
    for _ in 0..24 {
        let angle = random.next() * std::f64::consts::PI * 2.0;
        let radius = 105.0 + random.next() * 120.0;
        let x = clamp_number(anchor_x + angle.cos() * radius, WIDTH / 2.0, 55.0, WIDTH - 55.0);
        let y = clamp_number(anchor_y + angle.sin() * radius, HEIGHT / 2.0, 55.0, HEIGHT - 55.0);
        if locations.iter().all(|location| js_hypot(coord(location, "x") - x, coord(location, "y") - y) > 68.0) {
            return (x, y);
        }
    }
    (
        clamp_number(anchor_x + 110.0, WIDTH / 2.0, 55.0, WIDTH - 55.0),
        clamp_number(anchor_y + 70.0, HEIGHT / 2.0, 55.0, HEIGHT - 55.0),
    )
}

fn reconcile_map(raw_map: Option<&Value>, args: &ReconcileArgs) -> Result<Value, String> {
    // `concept ??= {}`, `scene ??= {}`: `null` — как пропущенное поле.
    let concept = args.concept.filter(|value| !value.is_null()).unwrap_or(&EMPTY_OBJECT);
    let current_location = args.current_location.unwrap_or(&EMPTY_STRING);
    let current_location_id = args.current_location_id.unwrap_or(&EMPTY_STRING);
    let previous_location = args.previous_location.unwrap_or(&EMPTY_STRING);
    let previous_location_id = args.previous_location_id.unwrap_or(&EMPTY_STRING);
    let known_locations = args.known_locations.unwrap_or(&EMPTY_ARRAY);
    let transition = args.transition.unwrap_or(&EMPTY_STRING);
    let scene = args.scene.filter(|value| !value.is_null()).unwrap_or(&EMPTY_OBJECT);

    let raw_seed = raw_map.and_then(|map| get(map, "seed"));
    let source = match raw_map {
        Some(map @ (Value::Object(_) | Value::Array(_))) => map,
        _ => &*EMPTY_OBJECT,
    };
    let created = create_map(&CreateArgs {
        seed: if js::truthy(raw_seed) { raw_seed } else { args.seed },
        campaign_name: args.campaign_name,
        concept,
        source,
        starting_location: current_location,
        starting_location_id: current_location_id,
        // У существующей карты новое место ставит сверка: она знает
        // предыдущую точку и выбирает свободную позицию рядом с ней.
        add_missing_starting_location: false,
    })?;
    let Value::Object(mut map) = created else {
        return Ok(created);
    };
    let map_seed = map.get("seed").and_then(Value::as_str).unwrap_or("").to_string();
    let mut current_location_id_value = map.get("currentLocationId").cloned().unwrap_or_else(|| json!(""));
    let regions: Vec<Value> = map.get("regions").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut locations: Vec<Value> = match map.get_mut("locations") {
        Some(Value::Array(items)) => std::mem::take(items),
        _ => Vec::new(),
    };
    let mut routes: Vec<Value> = match map.get_mut("routes") {
        Some(Value::Array(items)) => std::mem::take(items),
        _ => Vec::new(),
    };

    // `[...knownLocations, previousLocation, currentLocation]`: не-список
    // (`null`, строка старого сохранения) — пустой список.
    let known_items: Vec<Value> = match known_locations {
        Value::Array(items) => items.clone(),
        _ => Vec::new(),
    };
    let mut all_names: Vec<String> = Vec::new();
    for name in known_items.iter().chain([previous_location, current_location]) {
        let name = text(Some(name), 120);
        if !name.is_empty() && !all_names.contains(&name) {
            all_names.push(name);
        }
    }
    let current_key = key(Some(current_location));
    let previous_key = key(Some(previous_location));
    for name in all_names {
        let name_key = key_str(&name);
        let mut node = locations.iter().position(|location| key(get(location, "name")) == name_key);
        if node.is_none() {
            let anchor_index = location_by_id(&locations, Some(previous_location_id))
                .or_else(|| locations.iter().position(|location| key(get(location, "name")) == previous_key))
                .or_else(|| locations.iter().position(|location| strict_equal(get(location, "id"), Some(&current_location_id_value))))
                .or(if locations.is_empty() { None } else { Some(0) });
            let (anchor_x, anchor_y) = match anchor_index {
                Some(index) => (coord(&locations[index], "x"), coord(&locations[index], "y")),
                None => (WIDTH / 2.0, HEIGHT / 2.0),
            };
            let (x, y) = free_position(&map_seed, &locations, &name, anchor_x, anchor_y);
            let mut used: HashSet<String> = locations.iter().map(|location| str_field(location, "id").to_string()).collect();
            let id = unique_id(&slug_str(&name, "place"), &mut used);
            let kind = match get(scene, "scene_kind").and_then(Value::as_str) {
                Some("settlement") => "town",
                Some("dungeon") => "dungeon",
                _ => "landmark",
            };
            let summary = if name_key == current_key {
                text(or_else(get(scene, "objective"), Some(transition)), 320)
            } else {
                "Место, сохранённое в хронике кампании.".into()
            };
            locations.push(json!({
                "id": id,
                "name": name,
                "kind": kind,
                "x": js::num(x),
                "y": js::num(y),
                "regionId": nearest_region_id(&regions, x, y),
                "summary": summary,
                "known": true,
                "visited": true,
            }));
            node = Some(locations.len() - 1);
        }
        let Value::Array(known_list) = known_locations else {
            return Err("knownLocations.some is not a function".into());
        };
        if known_list.iter().any(|known| key(Some(known)) == name_key) || name_key == current_key {
            if let Some(index) = node {
                set_field(&mut locations[index], "visited", Value::Bool(true));
            }
        }
    }
    let previous = location_by_id(&locations, Some(previous_location_id))
        .or_else(|| locations.iter().position(|location| key(get(location, "name")) == previous_key));
    let current = location_by_id(&locations, Some(current_location_id))
        .or_else(|| locations.iter().position(|location| key(get(location, "name")) == current_key));
    if let Some(index) = current {
        set_field(&mut locations[index], "visited", Value::Bool(true));
        set_field(&mut locations[index], "known", Value::Bool(true));
        if !text(get(scene, "objective"), 180).is_empty() {
            set_field(&mut locations[index], "summary", Value::String(text(get(scene, "objective"), 320)));
        }
        current_location_id_value = get(&locations[index], "id").cloned().unwrap_or(Value::Null);
    }
    if let (Some(previous), Some(current)) = (previous, current) {
        let previous_id = str_field(&locations[previous], "id").to_string();
        let current_id = str_field(&locations[current], "id").to_string();
        if previous_id != current_id {
            let signature = pair_signature(&previous_id, &current_id);
            let exists =
                routes.iter().any(|route| pair_signature(str_field(route, "from"), str_field(route, "to")) == signature);
            if !exists {
                let transition_text = js_string(Some(transition));
                let kind = if sk_text::test(re!(r"река|river", "iu"), &transition_text) {
                    "river"
                } else if sk_text::test(re!(r"перевал|pass", "iu"), &transition_text) {
                    "pass"
                } else {
                    "road"
                };
                let distance = travel_distance(&locations[previous], &locations[current]);
                let danger = match get(scene, "danger").and_then(Value::as_str) {
                    Some("высокая") => "высокая",
                    Some("низкая") => "низкая",
                    _ => "средняя",
                };
                routes.push(route_value(
                    format!("route-{}", &hash(&signature)[..10]),
                    &previous_id,
                    &current_id,
                    json!(kind),
                    distance,
                    json!(danger),
                    true,
                ));
            }
        }
    }
    locations.truncate(50);
    let valid_ids: HashSet<&str> = locations.iter().map(|location| str_field(location, "id")).collect();
    let routes: Vec<Value> = routes
        .into_iter()
        .filter(|route| valid_ids.contains(str_field(route, "from")) && valid_ids.contains(str_field(route, "to")))
        .take(100)
        .collect();
    map.insert("currentLocationId".into(), current_location_id_value);
    map.insert("locations".into(), Value::Array(locations));
    map.insert("routes".into(), Value::Array(routes));
    Ok(Value::Object(map))
}

/// `reconcileWorldMap(rawMap, { seed, campaignName, concept = {},
/// currentLocation = '', currentLocationId = '', previousLocation = '',
/// previousLocationId = '', knownLocations = [], transition = '', scene = {} })`
/// — пересобрать карту и вписать в неё места из хроники: новое место встаёт
/// рядом с предыдущим, текущее становится канонической точкой и соединяется
/// дорогой с прошлым.
pub fn reconcile_world_map(raw_map: Option<&Value>, options: &Value) -> Result<Value, String> {
    if options.is_null() {
        return Err(DESTRUCTURE_NULL_SEED.into());
    }
    reconcile_map(
        raw_map,
        &ReconcileArgs {
            seed: get(options, "seed"),
            campaign_name: get(options, "campaignName"),
            concept: get(options, "concept"),
            current_location: get(options, "currentLocation"),
            current_location_id: get(options, "currentLocationId"),
            previous_location: get(options, "previousLocation"),
            previous_location_id: get(options, "previousLocationId"),
            known_locations: get(options, "knownLocations"),
            transition: get(options, "transition"),
            scene: get(options, "scene"),
        },
    )
}

/// `JSON.stringify(value)` для JSON без `undefined`: ключи в порядке
/// `Object.keys`, числа — как `String(number)` в JS.
pub(crate) fn json_stringify(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&sk_core::js::f64_string(number.as_f64().unwrap_or(f64::NAN))),
        Value::String(raw) => out.push_str(&serde_json::to_string(raw).unwrap_or_default()),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                json_stringify(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, (name, item)) in js::entries(map).into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(name).unwrap_or_default());
                out.push(':');
                json_stringify(item, out);
            }
            out.push('}');
        }
    }
}

/// `ensureCampaignWorldMap(state)` — карта мира из состояния кампании: сид
/// карты или хеш кода сессии, кампании и концепта; места из
/// `adventure.visitedLocations` и истории; текущая сцена и предыдущая точка
/// истории. Состояние без полей — `{}`; `null` — `TypeError`, как в JS.
pub fn ensure_campaign_world_map(state: &Value) -> Result<Value, String> {
    if state.is_null() {
        return Err(type_error_reading("adventure"));
    }
    let adventure = get(state, "adventure").filter(|adventure| adventure.is_object() || adventure.is_array()).unwrap_or(&EMPTY_OBJECT);
    let history = get(adventure, "history");
    let history_items = history.and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    // `entry?.location`: у не-объекта поля нет; `undefined` и `null` для
    // имени места равнозначны.
    let history_locations = history_items.iter().map(|entry| get(entry, "location").cloned().unwrap_or(Value::Null));
    let visited = get(adventure, "visitedLocations").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let known_locations = Value::Array(visited.iter().cloned().chain(history_locations).collect());

    let world_map = get(state, "worldMap");
    let map_seed = world_map.and_then(|map| get(map, "seed"));
    let seed = if js::truthy(map_seed) {
        map_seed.cloned()
    } else {
        let mut fingerprint = Map::new();
        for (name, field) in [("code", "sessionCode"), ("campaign", "campaign"), ("concept", "campaignConcept")] {
            if let Some(value) = get(state, field) {
                fingerprint.insert(name.into(), value.clone());
            }
        }
        let mut serialized = String::new();
        json_stringify(&Value::Object(fingerprint), &mut serialized);
        Some(Value::String(hash(&serialized)[..24].to_string()))
    };
    let scene = get(state, "scene");
    let last = history.and_then(Value::as_array).and_then(|items| items.last());
    let scene_field = |name: &str| scene.and_then(|scene| get(scene, name));
    let last_field = |name: &str| last.and_then(|entry| get(entry, name));
    reconcile_map(
        world_map,
        &ReconcileArgs {
            seed: seed.as_ref(),
            campaign_name: get(state, "campaign"),
            concept: get(state, "campaignConcept"),
            current_location: scene_field("location"),
            current_location_id: coalesce(scene_field("location_id"), scene_field("locationId")),
            previous_location: last_field("location"),
            previous_location_id: coalesce(last_field("location_id"), last_field("locationId")),
            known_locations: Some(&known_locations),
            transition: get(adventure, "lastTransition"),
            scene,
        },
    )
}

/// Перенос `test/world-map.test.mjs` (без проекции игрока), части
/// `test/location-identity.test.mjs` и `test/world-map-render.test.mjs`,
/// касающейся самой карты.
#[cfg(test)]
mod tests {
    use super::*;

    fn create(input: Value) -> Value {
        create_campaign_world_map(&input).expect("карта собирается")
    }

    fn reconcile(map: &Value, options: Value) -> Value {
        reconcile_world_map(Some(map), &options).expect("карта сверяется")
    }

    fn locations(map: &Value) -> &Vec<Value> {
        map["locations"].as_array().expect("места")
    }

    fn routes(map: &Value) -> &Vec<Value> {
        map["routes"].as_array().expect("дороги")
    }

    fn by_name<'a>(map: &'a Value, name: &str) -> &'a Value {
        locations(map).iter().find(|location| location["name"] == name).expect("место есть на карте")
    }

    fn by_id<'a>(map: &'a Value, id: &str) -> &'a Value {
        locations(map).iter().find(|location| location["id"] == id).expect("место есть на карте")
    }

    fn connects(map: &Value, first: &Value, second: &Value) -> bool {
        routes(map).iter().any(|route| {
            (route["from"] == *first && route["to"] == *second) || (route["from"] == *second && route["to"] == *first)
        })
    }

    #[test]
    fn campaign_map_is_deterministic_and_connected() {
        let input = json!({ "seed": "WORLD-42", "campaignName": "Пепельный рубеж", "concept": { "genre": "тёмное фэнтези" }, "startingLocation": "Норвин" });
        let first = create(input.clone());
        assert_eq!(first, create(input));
        assert!(first["regions"].as_array().expect("регионы").len() >= 3);
        assert!(locations(&first).len() >= 8);
        assert!(routes(&first).len() >= locations(&first).len() - 1);
        let start = by_name(&first, "Норвин");
        assert_eq!(first["currentLocationId"], start["id"]);
        assert_eq!(start["visited"], json!(true));
    }

    #[test]
    fn routes_by_name_keep_case_insensitive_first_match() {
        let map = create(json!({
            "seed": "ROUTE-NAMES", "startingLocationId": "port",
            "source": {
                "locations": [
                    { "id": "port", "name": "ЮЖНЫЙ ПОРТ" },
                    { "id": "южный порт", "name": "Северная бухта" },
                    { "id": "tower", "name": "Башня Ёлки" },
                ],
                "routesComplete": true,
                "routes": [
                    { "from": "южный порт", "to": "  БАШНЯ\nЁЛКИ " },
                    { "from": "tower", "to": "port" },
                    { "from": "нет такого места", "to": "tower" },
                    { "from": "port", "to": "port" },
                ],
            },
        }));
        let pairs: Vec<(Value, Value)> = routes(&map).iter().map(|route| (route["from"].clone(), route["to"].clone())).collect();
        assert_eq!(pairs, [(json!("port"), json!("tower"))]);
    }

    #[test]
    fn starting_scene_is_added_instead_of_first_authored_point() {
        let map = create(json!({
            "seed": "MISMATCH-1",
            "campaignName": "Несогласованный мир",
            "startingLocation": "Несуществующий старт",
            "source": {
                "locations": [
                    { "id": "foreign-fort", "name": "Чужой форт", "kind": "fortress", "known": true },
                    { "id": "foreign-port", "name": "Чужой порт", "kind": "port", "known": true },
                ],
            },
        }));
        let current = by_id(&map, map["currentLocationId"].as_str().expect("id"));
        assert_eq!(current["name"], "Несуществующий старт");
        assert_eq!(current["kind"], "landmark", "вид отсутствующей точки не выдумывается из первой записи");
        assert_eq!(current["visited"], json!(true));
    }

    #[test]
    fn new_scene_becomes_canonical_and_joins_previous() {
        let initial = create(json!({ "seed": "ROUTE-1", "campaignName": "Дороги", "startingLocation": "Старый порт" }));
        let updated = reconcile(
            &initial,
            json!({
                "campaignName": "Дороги", "currentLocation": "Башня у перевала", "previousLocation": "Старый порт",
                "knownLocations": ["Старый порт", "Башня у перевала"], "transition": "Дорога поднимается к перевалу.",
                "scene": { "objective": "Зажечь маяк", "scene_kind": "dungeon", "danger": "высокая" },
            }),
        );
        let destination = by_name(&updated, "Башня у перевала");
        let origin = by_name(&updated, "Старый порт");
        assert_eq!(updated["currentLocationId"], destination["id"]);
        assert_eq!(destination["kind"], "dungeon");
        assert!(connects(&updated, &origin["id"], &destination["id"]));
        assert!(routes(&updated).len() >= locations(&updated).len() - 1);
        let route = routes(&updated)
            .iter()
            .find(|route| route["from"] == origin["id"] && route["to"] == destination["id"])
            .expect("новая дорога сверки");
        assert_eq!(route["kind"], "pass", "переход через перевал — перевал");
        assert_eq!(route["danger"], "высокая");
    }

    #[test]
    fn chronicle_places_of_old_campaign_appear_on_map() {
        let world_map = ensure_campaign_world_map(&json!({
            "sessionCode": "LEGACY-MAP", "campaign": "Старая хроника", "campaignConcept": { "worldSummary": "Мир старых дорог." },
            "scene": { "location": "Серебряный монастырь", "objective": "Найти колокол" },
            "adventure": {
                "visitedLocations": ["Пепельный брод", "Серебряный монастырь"],
                "history": [{ "location": "Пепельный брод" }, { "location": "Рыночная площадь" }],
            },
        }))
        .expect("карта из состояния");
        for name in ["Пепельный брод", "Рыночная площадь", "Серебряный монастырь"] {
            by_name(&world_map, name);
        }
    }

    #[test]
    fn repeated_visit_updates_canonical_summary() {
        let initial = create(json!({ "seed": "SUMMARY-1", "campaignName": "Хроника", "startingLocation": "Норвин" }));
        let location_id = initial["currentLocationId"].clone();
        let updated = reconcile(
            &initial,
            json!({
                "seed": initial["seed"], "campaignName": "Хроника", "currentLocationId": location_id, "currentLocation": "Норвин",
                "scene": { "objective": "После пожара площадь стала непроходимой." },
            }),
        );
        assert_eq!(by_id(&updated, location_id.as_str().expect("id"))["summary"], "После пожара площадь стала непроходимой.");
    }

    #[test]
    fn authored_background_and_lore_survive_create_and_reconcile() {
        let hooks = json!(["Пропавший астроном оставил карту под старой башней.", "Городская вода мутнеет каждое новолуние."]);
        let history = "Люмен вырос вокруг обломка небесного маяка и пережил три осады.";
        let source = json!({
            "name": "Море стекла",
            "backgroundImage": "/assets/maps/world/skazanie/sea-of-glass-v2.webp",
            "backgroundAlt": "Побережье, пустыня и горные проходы Мира стекла",
            "regions": [
                { "id": "coast", "name": "Янтарный берег", "biome": "coast", "x": 200, "y": 180, "radius": 180 },
                { "id": "desert", "name": "Море стекла", "biome": "desert", "x": 500, "y": 320, "radius": 220 },
                { "id": "mountains", "name": "Горный венец", "biome": "mountains", "x": 800, "y": 480, "radius": 180 },
            ],
            "locations": [{
                "id": "city-lumen", "name": "Люмен", "kind": "city", "region": "Море стекла", "x": 500, "y": 320,
                "summary": "Город на месте древней обсерватории.", "known": true, "visited": true,
                "history": history, "storyHooks": hooks,
            }],
        });
        let created = create(json!({ "seed": "WORLD-LORE-1", "campaignName": "Стеклянный путь", "startingLocation": "Люмен", "source": source }));
        assert_eq!(created["backgroundImage"], source["backgroundImage"]);
        assert_eq!(created["backgroundAlt"], source["backgroundAlt"]);
        assert_eq!(by_id(&created, "city-lumen")["storyHooks"], hooks);
        assert_eq!(by_id(&created, "city-lumen")["history"], history);
        assert_eq!(by_id(&created, "city-lumen")["regionId"], "desert");

        let reconciled = reconcile(
            &created,
            json!({
                "seed": created["seed"], "campaignName": "Стеклянный путь", "currentLocation": "Люмен", "currentLocationId": "city-lumen",
                "scene": { "objective": "Вернуться к обсерватории." },
            }),
        );
        assert_eq!(reconciled["backgroundImage"], source["backgroundImage"]);
        assert_eq!(reconciled["backgroundAlt"], source["backgroundAlt"]);
        assert_eq!(by_id(&reconciled, "city-lumen")["history"], history);
        assert_eq!(by_id(&reconciled, "city-lumen")["storyHooks"], hooks);
    }

    #[test]
    fn background_accepts_only_versioned_internal_webp() {
        let valid = ["/assets/maps/world/skazanie/ashen-coast-v1.webp", "/assets/maps/world/skazanie/map-42-v12.webp"];
        let invalid = [
            "https://example.test/assets/maps/world/skazanie/ashen-coast-v1.webp",
            "//cdn.example.test/map-v1.webp",
            "/assets/maps/world/skazanie/ashen-coast.webp",
            "/assets/maps/world/skazanie/ashen-coast-v1.png",
            "/assets/maps/world/skazanie/../secret-v1.webp",
            "/assets/maps/world/skazanie/Ashen-coast-v1.webp?cache=1",
            "/assets/maps/world/skazanie/ashen_coast-v1.webp",
            "/assets/maps/world/skazanie/ashen-coast-v0.webp",
        ];
        for candidate in valid {
            assert_eq!(safe_world_map_background_url(Some(&json!(candidate))), candidate);
        }
        for candidate in invalid {
            assert_eq!(safe_world_map_background_url(Some(&json!(candidate))), "", "{candidate}");
        }
        let map = create(json!({
            "seed": "WORLD-UNSAFE-BACKGROUND", "campaignName": "Безопасная карта", "startingLocation": "Старт",
            "source": { "backgroundImage": invalid[0], "backgroundAlt": "Не должен пройти" },
        }));
        assert!(map.get("backgroundImage").is_none());
        assert!(map.get("backgroundAlt").is_none());
    }

    #[test]
    fn lore_is_bounded_and_skips_non_string_hooks() {
        let long_history = "история ".repeat(300);
        let map = create(json!({
            "seed": "WORLD-LORE-BOUNDS", "campaignName": "Границы", "startingLocation": "Город",
            "source": {
                "locations": [{
                    "id": "city", "name": "Город", "kind": "city", "x": 500, "y": 320, "history": long_history,
                    "storyHooks": ["первая", 42, { "text": "нет" }, "вторая", "третья", "лишняя"], "known": true, "visited": true,
                }],
            },
        }));
        let location = by_id(&map, "city");
        assert_eq!(location["history"].as_str().expect("история").chars().count(), 1_200);
        assert_eq!(location["storyHooks"], json!(["первая", "вторая", "третья"]));
    }

    fn city_overview() -> Value {
        json!({
            "version": 1,
            "name": "План города",
            "summary": "Шесть кварталов вокруг старой площади.",
            "image": "/assets/maps/city/skazanie/test-city-v1.webp",
            "imageAlt": "Город сверху",
            "width": 1000,
            "height": 640,
            "districts": [{
                "id": "old-quarter", "name": "Старый квартал", "x": 300, "y": 220,
                "bounds": { "x": 100, "y": 80, "width": 350, "height": 260 },
                "summary": "Каменные дома.", "history": "Первый район города.", "storyHooks": ["Пропал ключ.", "Звонит колокол."],
                "secret": "не проецировать",
            }],
            "places": [{
                "id": "old-tower", "name": "Старая башня", "kind": "tower", "districtId": "old-quarter", "x": 260, "y": 180,
                "summary": "Башня над площадью.", "history": "Стоит три века.", "storyHooks": ["Погас огонь.", "Открылась дверь."],
                "destinationLocationId": "forged", "danger": "высокая",
            }],
            "routes": [{ "from": "old-quarter", "to": "old-tower" }],
            "currentLocationId": "old-tower",
        })
    }

    #[test]
    fn city_overview_survives_create_and_reconcile_as_presentation_only() {
        let map = create(json!({
            "seed": "CITY-OVERVIEW", "campaignName": "Город", "startingLocation": "Столица",
            "source": { "locations": [{ "id": "capital", "name": "Столица", "kind": "capital", "x": 500, "y": 320, "known": true, "visited": true, "cityOverview": city_overview() }] },
        }));
        let overview = by_id(&map, "capital")["cityOverview"].clone();
        assert_eq!(overview["image"], city_overview()["image"]);
        assert_eq!(overview["districts"][0]["name"], "Старый квартал");
        assert!(overview["districts"][0].get("secret").is_none());
        assert!(overview["places"][0].get("destinationLocationId").is_none());
        assert!(overview.get("routes").is_none());
        assert!(overview.get("currentLocationId").is_none());

        let reconciled = reconcile(&map, json!({ "campaignName": "Город", "currentLocation": "Столица", "currentLocationId": "capital" }));
        assert_eq!(by_id(&reconciled, "capital")["cityOverview"], overview);
    }

    #[test]
    fn city_overview_accepts_only_versioned_webp_and_valid_district_refs() {
        assert_eq!(
            safe_city_overview_image_url(Some(&json!("/assets/maps/city/skazanie/veld-burg-v1.webp"))),
            "/assets/maps/city/skazanie/veld-burg-v1.webp"
        );
        for unsafe_url in ["https://example.test/city.webp", "/assets/maps/city/skazanie/city.png", "/assets/maps/city/skazanie/../city-v1.webp"] {
            assert_eq!(safe_city_overview_image_url(Some(&json!(unsafe_url))), "");
        }
        assert_eq!(
            normalize_city_overview(Some(&json!({
                "name": "Подмена", "summary": "Подмена", "image": "https://example.test/city.webp", "width": 1000, "height": 640,
                "districts": [], "places": [],
            }))),
            None
        );
        assert_eq!(
            normalize_city_overview(Some(&json!({
                "name": "Город", "summary": "Город", "image": "/assets/maps/city/skazanie/city-v1.webp", "width": 1000, "height": 640,
                "districts": [{ "id": "district", "name": "Район", "x": 100, "y": 100, "bounds": { "x": 20, "y": 20, "width": 200, "height": 200 } }],
                "places": [{ "id": "place", "name": "Место", "districtId": "missing", "x": 100, "y": 100 }],
            }))),
            None
        );
    }

    /// `test/location-identity.test.mjs`: одинаковые имена мест различаются
    /// каноническим `location_id`.
    #[test]
    fn duplicate_labels_are_selected_and_linked_by_location_id() {
        let map = create(json!({
            "seed": "LOCATION-IDENTITY-1",
            "campaignName": "Identity test",
            "startingLocation": "Twin Market",
            "startingLocationId": "market-west",
            "source": {
                "locations": [
                    { "id": "market-east", "name": "Twin Market", "kind": "town", "x": 300, "y": 280 },
                    { "id": "market-west", "name": "Twin Market", "kind": "town", "x": 650, "y": 310 },
                ],
            },
        }));
        assert_eq!(map["currentLocationId"], "market-west");
        assert_eq!(world_location_by_id(Some(&map), "market-east").expect("место")["name"], "Twin Market");

        let updated = reconcile(
            &map,
            json!({
                "campaignName": "Identity test", "currentLocation": "Twin Market", "currentLocationId": "market-east",
                "previousLocation": "Twin Market", "previousLocationId": "market-west", "knownLocations": ["Twin Market"],
                "transition": "Travel east",
            }),
        );
        assert_eq!(updated["currentLocationId"], "market-east");
        assert!(connects(&updated, &json!("market-west"), &json!("market-east")));
    }

    /// `test/world-map-render.test.mjs` (часть карты): повторная сборка даёт
    /// ту же карту, в ней есть старт и нет `NaN`.
    #[test]
    fn rendered_map_input_is_stable_and_numeric() {
        let input = json!({ "seed": "private-world-seed", "campaignName": "Проверка карты", "startingLocation": "Норвин" });
        let map = create(input.clone());
        assert_eq!(map, create(input));
        by_name(&map, "Норвин");
        let text = serde_json::to_string(&map).expect("JSON");
        assert!(!text.contains("NaN") && !text.contains("null"), "все координаты и поля карты — числа и строки");
    }

    #[test]
    fn null_inputs_fail_with_v8_type_errors() {
        assert_eq!(create_campaign_world_map(&Value::Null), Err(DESTRUCTURE_NULL_SEED.into()));
        assert_eq!(reconcile_world_map(None, &Value::Null), Err(DESTRUCTURE_NULL_SEED.into()));
        // Старое сохранение: `null` вместо концепта, карты, сцены и списка мест —
        // как пропущенное поле (`test/old-save-registries.test.mjs`).
        let plain = create_campaign_world_map(&json!({ "seed": "s" })).expect("карта");
        assert_eq!(create_campaign_world_map(&json!({ "seed": "s", "concept": null, "source": null })), Ok(plain));
        for known in [json!(null), json!("ab"), json!(5)] {
            let options = json!({ "seed": "s", "knownLocations": known, "scene": null, "concept": null, "currentLocation": "Норвин" });
            assert!(reconcile_world_map(None, &options).is_ok(), "{options}");
        }
        assert_eq!(ensure_campaign_world_map(&Value::Null), Err(type_error_reading("adventure")));
        // Отсутствующие поля — значения по умолчанию, как `= {}` в JS.
        assert!(create_campaign_world_map(&json!({})).is_ok());
        assert!(ensure_campaign_world_map(&json!({})).is_ok());
    }

    /// `null` среди мест пропускается, как в JS.
    #[test]
    fn lookup_skips_null_entries() {
        let map = json!({ "locations": [null, 5, { "id": "port", "name": "Порт" }] });
        assert_eq!(world_location_by_id(Some(&map), " port ").expect("место")["name"], "Порт");
        assert_eq!(world_location_by_id(Some(&map), ""), None);
        assert_eq!(world_location_by_id(None, "port"), None);
    }

    #[test]
    fn slug_and_text_follow_js() {
        assert_eq!(slug_str("  Башня у\u{a0}перевала! ", "place"), "башня-у-перевала");
        assert_eq!(slug_str("---", "place"), "place");
        assert_eq!(slug_str("\u{212A}elvin Keep", "place"), "kelvin-keep");
        assert_eq!(text_str("a\u{FEFF}\u{85}b", 10), "a \u{85}b");
        assert_eq!(text_str("ﬁ①", 10), "fi1");
        // Срез по единицам UTF-16: эмодзи занимает две.
        assert_eq!(text_str(&"😀".repeat(3), 4), "😀😀");
        let mut used = HashSet::from(["a".to_string(), "a-2".to_string()]);
        assert_eq!(unique_id("a", &mut used), "a-3");
    }
}

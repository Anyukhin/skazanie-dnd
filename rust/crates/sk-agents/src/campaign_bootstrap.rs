//! Перенос `server/campaign-bootstrap.mjs`: создание кампании — исходная
//! ситуация, первая сцена с картой, жители, память мира, стартовое задание.
//!
//! Модель (`prompts/campaign_creator/v8.txt`, встроен при сборке) пишет мир
//! только для свободной кампании: клиент внедряется ([`LlmClient`]), вводные
//! владельца и листы героев уходят внутри `UNTRUSTED_DATA`. Без клиента, при
//! отказе провайдера или для авторского шаблона мира работает
//! детерминированный путь (`local-storyteller` / `authored-world-template`):
//! новая кампания всегда играбельна. Ответ модели только нормализуется
//! ([`normalize_opening_canon`] и внутренний `normalize_opening`) — механику он
//! не задаёт: карта, расстановка, часы и факты собираются сервером.
//!
//! Случайность (зерно вдохновения) — через внедрённую функцию
//! [`InspirationDraw`]: в JS это `diceService`, в Rust крейт костей в
//! зависимостях `sk-agents` не значится, поэтому бросок делает вызывающий
//! (`draw_campaign_inspiration(world, Some(dice))`).

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context, Poll, Waker};

use serde_json::{json, Map, Value};
use sk_agents_base::llm_client::LlmClient;
use sk_character::character_lifecycle::{party_presentation_for, MAX_CHARACTER_LEVEL};
use sk_chargen::starter_kit::{with_starter_kit, StarterKitOptions, STARTER_KIT_2024_POLICY};
use sk_core::fancy_regex::Regex;
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{clock, hash, js, re, text};
use sk_director::adventure_director::{generate_scene_geometry, level_key_js, library_scene_fields, opening_entry_side, remember_scene_map};
use sk_director::scene_memory::ensure_scene_world_memory;
use sk_economy::merchant_economy::{create_starter_merchant, normalize_inventory_item, normalize_merchants, InventoryItemOptions, ECONOMY_POLICY_ID};
use sk_geometry::world_map::create_campaign_world_map;
use sk_items::item_catalog::materialize_catalog_item;
use sk_memory::party_decision::DEFAULT_PARTY_DECISION_POLICY;
use sk_memory::world_memory::{gm_secret_fact, normalize_gm_secrets};
use sk_narration_base::campaign_inspiration::{draw_campaign_inspiration, inspiration_prompt_seed, CampaignInspiration};
use sk_npc_world::npc_positioning::{apply_npc_world_event, plan_scene_npc_placement_events};
use sk_ruleset::ruleset_config::{ruleset_lock, ProfileOptions, LEGACY_DEFAULT_RULESET_ID};
use sk_scenario::campaign_scenario::{build_scenario_arc_plan, scenario_clue_fact_ids_known_by, scenario_for_world_template, scenario_secrets_for};
use sk_scene_base::scene_map_design::{normalize_scene_map_design, world_location_design_context};
use sk_scene_base::scene_requirements::scene_map_requirements_for;
use sk_society::campaign_stories::validate_campaign_mode;
use sk_story::campaign_loop_policy::build_campaign_arc_plan;
use sk_tactical::tactical_map::{cell_at, deserialize_tactical_map, legacy_cells_from_tactical_map, reachable_cells, serialize_tactical_map, TacticalMap, SIZE_CLASSES};
use sk_tactics::security::build_data_only_context;
use sk_themes::scene_themes::{is_live_theme, resolve_scene_theme, SCENE_THEME_IDS};
use sk_world_life::world_offices::normalize_world_offices_state;
use sk_world_story::scenario_knight::{scenario_knight_starting_inventory, scenario_night_visitor_ids};
use sk_world_story::scene_canon::{campaign_start_canon, requested_opening_canon};
use sk_world_time::world_template_catalog::{get_world_template, world_template_concept, world_template_opening};

use crate::lore_author::LoreAuthor;

/// `prompts/campaign_creator/v8.txt`.
pub const CAMPAIGN_CREATOR_PROMPT: &str = include_str!("../../../../prompts/campaign_creator/v8.txt");

/// Срок создания мира: разовая операция на экране создания, первой модели —
/// весь срок, повтору — остаток.
pub const CAMPAIGN_BOOTSTRAP_TIMEOUT_MS: i64 = 120_000;
/// Повтор — только при недоступности провайдера.
const CAMPAIGN_BOOTSTRAP_RETRY_CODES: [&str; 3] = ["LLM_FALLBACK_EXHAUSTED", "LLM_PROVIDER_UNAVAILABLE", "LLM_PROVIDER_ERROR"];
const CAMPAIGN_BOOTSTRAP_RETRY_MINIMUM_MS: i64 = 30_000;
/// Пауза перед повтором по умолчанию.
pub const CAMPAIGN_BOOTSTRAP_RETRY_PAUSE_MS: f64 = 5_000.0;

const OPENING_CANON_LIMIT: usize = 6;
const STARTER_QUEST_TITLE_LIMIT: usize = 72;

// --- ошибка -------------------------------------------------------------------------

/// Исключение `create` в форме JS: класс, код и текст.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapError {
    pub name: String,
    pub code: Option<String>,
    pub message: String,
}

impl BootstrapError {
    /// `new Error(message)`.
    pub fn error(message: impl Into<String>) -> Self {
        Self { name: "Error".into(), code: None, message: message.into() }
    }

    pub fn new(name: impl Into<String>, code: Option<String>, message: impl Into<String>) -> Self {
        Self { name: name.into(), code, message: message.into() }
    }

    /// `{ name, code, message }` (без `code`, если его нет).
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("name".into(), Value::String(self.name.clone()));
        if let Some(code) = &self.code {
            map.insert("code".into(), Value::String(code.clone()));
        }
        map.insert("message".into(), Value::String(self.message.clone()));
        Value::Object(map)
    }
}

impl std::fmt::Display for BootstrapError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.name, self.message)
    }
}

impl std::error::Error for BootstrapError {}

fn type_error(message: impl Into<String>) -> BootstrapError {
    BootstrapError::new("TypeError", None, message)
}

impl From<sk_director::adventure_director::DirectorError> for BootstrapError {
    fn from(error: sk_director::adventure_director::DirectorError) -> Self {
        Self { name: error.name, code: error.code, message: error.message }
    }
}

impl From<sk_tactical::tactical_map::TacticalMapError> for BootstrapError {
    fn from(error: sk_tactical::tactical_map::TacticalMapError) -> Self {
        Self { name: error.name.into(), code: Some(error.code), message: error.message }
    }
}

impl From<sk_world_time::world_template_catalog::WorldTemplateCatalogError> for BootstrapError {
    fn from(error: sk_world_time::world_template_catalog::WorldTemplateCatalogError) -> Self {
        Self { name: error.name.into(), code: Some(error.code), message: error.message }
    }
}

// --- приведения JS --------------------------------------------------------------------

fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        None | Some(Value::Null) => second,
        some => some,
    }
}

fn is_plain(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_)))
}

/// `value && typeof value === 'object'` (массив тоже объект).
fn is_object_like(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_) | Value::Array(_)))
}

fn list(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn string(text: impl Into<String>) -> Value {
    Value::String(text.into())
}

fn str_of(value: Option<&Value>) -> String {
    js::s(value)
}

/// `clean(value, maximum)`: `String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum)`.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    text::head(&text::squash_spaces(&js::s(value)), maximum)
}

fn clean_str(value: &str, maximum: usize) -> String {
    text::head(&text::squash_spaces(value), maximum)
}

/// `prose(value, maximum)`: абзацы сохраняются, пробелы внутри строк схлопнуты,
/// больше двух переводов строки подряд — два.
fn prose(value: Option<&Value>, maximum: usize) -> String {
    prose_str(&js::s(value), maximum)
}

fn prose_str(value: &str, maximum: usize) -> String {
    let without_cr = value.replace('\r', "");
    let spaced = text::replace_all(re!(r"[^\S\n]+", "g"), &without_cr, " ");
    let paragraphs = text::replace_all(re!(r"\n{3,}", "g"), &spaced, "\n\n");
    text::head(text::trim(&paragraphs), maximum)
}

fn lower(value: &str) -> String {
    text::lower(value)
}

/// `text.split(regex)` по правилам JS (разделители без групп).
fn split_re(regex: &Regex, value: &str) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut last = 0;
    for found in regex.find_iter(value).filter_map(Result::ok) {
        if found.end() == found.start() {
            continue;
        }
        pieces.push(value[last..found.start()].to_string());
        last = found.end();
    }
    pieces.push(value[last..].to_string());
    pieces
}

/// `integer(value, fallback, minimum, maximum)`.
fn integer(value: Option<&Value>, fallback: f64, minimum: f64, maximum: f64) -> f64 {
    if js::is_safe_integer_number(value) {
        let number = js::number(value);
        minimum.max(maximum.min(number))
    } else {
        fallback
    }
}

/// `decimal(value, fallback, minimum, maximum)`.
fn decimal(value: Option<&Value>, fallback: f64, minimum: f64, maximum: f64) -> f64 {
    let number = js::number(value);
    if number.is_finite() {
        minimum.max(maximum.min(number))
    } else {
        fallback
    }
}

fn num(value: f64) -> Value {
    js::num(value)
}

/// `capitalize(value)`: первая буква — заглавной.
fn capitalize(value: Option<&Value>) -> String {
    text::capitalize(text::trim(&js::s(value)))
}

fn sha_hex(value: &str) -> String {
    hash::sha256_hex(value.as_bytes())
}

// --- пролог и канон -----------------------------------------------------------------

/// Факты пролога: абзацы до тысячи знаков, не больше восьми.
fn opening_narration_facts(opening: &Value, location_entity: Option<&Value>, campaign_code: &str, recorded_at: &Value) -> Vec<Value> {
    let Some(entity_id) = prop(location_entity, "id").filter(|id| js::truthy(Some(id))) else { return Vec::new() };
    let entity_id = js::string(Some(entity_id));
    let narration = prose(prop(Some(opening), "openingNarration"), 4_000);
    let mut paragraphs = Vec::new();
    for paragraph in split_re(re!(r"\n{2,}", "u"), &narration) {
        let normalized: Vec<char> = prose_str(&paragraph, 4_000).chars().collect();
        let chunks = normalized.len().div_ceil(1_000);
        for index in 0..chunks {
            let end = ((index + 1) * 1_000).min(normalized.len());
            paragraphs.push(normalized[index * 1_000..end].iter().collect::<String>());
        }
    }
    let title = clean(prop(prop(Some(opening), "scene"), "title"), 160);
    paragraphs
        .into_iter()
        .filter(|summary| !summary.is_empty())
        .take(8)
        .enumerate()
        .map(|(index, summary)| {
            let id = text::head(&sha_hex(&format!("opening-narration\u{0}{campaign_code}\u{0}{entity_id}\u{0}{index}\u{0}{summary}")), 24);
            json!({
                "id": format!("fact:opening:{id}"),
                "subject_id": prop(location_entity, "id"),
                "predicate": "opening_narration",
                "object": format!("Подтверждённый пролог сцены «{title}»"),
                "summary": summary,
                "visibility": "party",
                "source_event_ids": [],
                "source_command_id": format!("campaign-bootstrap:{campaign_code}"),
                "supersedes_fact_id": "",
                "status": "active",
                "recorded_at_minutes": recorded_at,
            })
        })
        .collect()
}

/// `TITLE_TAIL_RE`.
fn title_tail() -> &'static Regex {
    re!(r"[\s.!?…;:,—–-]+$", "u")
}

/// `shortQuestTitle(value)`: первое предложение, длинное — до запятой или по слову.
fn short_quest_title(value: Option<&Value>) -> String {
    let cleaned = clean(value, 500);
    let first = split_re(re!(r"(?<=[.!?…])\s+", "u"), &cleaned).into_iter().next().unwrap_or_default();
    let sentence = text::replace_all(title_tail(), &first, "");
    if text::len(&sentence) <= STARTER_QUEST_TITLE_LIMIT {
        return sentence;
    }
    let clause_first = split_re(re!(r"\s*[;:—–]\s+|,\s+", "u"), &sentence).into_iter().next().unwrap_or_default();
    let clause = text::replace_all(title_tail(), &clause_first, "");
    let clause_length = text::len(&clause);
    if (12..=STARTER_QUEST_TITLE_LIMIT).contains(&clause_length) {
        return clause;
    }
    let head = text::head(&sentence, STARTER_QUEST_TITLE_LIMIT);
    let by_word = match head.rfind(' ') {
        Some(at) => head[..at].to_string(),
        None => head,
    };
    format!("{}…", text::replace_all(title_tail(), &by_word, ""))
}

/// `starterQuestTitle(opening)`: строка, которую пролог уже произнёс, —
/// не название задачи.
fn starter_quest_title(opening: &Value) -> String {
    let narration = lower(&clean(prop(Some(opening), "openingNarration"), 4_000));
    let scene = prop(Some(opening), "scene");
    for candidate in [prop(Some(opening), "hook"), prop(scene, "objective"), prop(scene, "title")] {
        let title = short_quest_title(candidate);
        if !title.is_empty() && !narration.contains(&lower(&text::replace_all(re!(r"…$", "u"), &title, ""))) {
            return title;
        }
    }
    "Первая зацепка".to_string()
}

/// `startingLevel(value)`.
fn starting_level(value: Option<&Value>) -> Result<i64, BootstrapError> {
    match value {
        None | Some(Value::Null) => return Ok(1),
        Some(Value::String(text)) if text.is_empty() => return Ok(1),
        _ => {}
    }
    let number = js::number(value);
    if !js::is_safe_integer_number(value) || number < 1.0 || number > MAX_CHARACTER_LEVEL as f64 {
        return Err(BootstrapError::error(format!("Начальный уровень должен быть целым числом от 1 до {MAX_CHARACTER_LEVEL}")));
    }
    Ok(number as i64)
}

const WORLD_FIELDS: [(&str, usize); 11] = [
    ("preset", 300),
    ("era", 80),
    ("genre", 100),
    ("tone", 160),
    ("premise", 1000),
    ("themes", 400),
    ("boundaries", 500),
    ("magicLevel", 80),
    ("technologyLevel", 80),
    ("startingLocation", 160),
    ("openingSituation", 800),
];

/// `normalizeWorld(input = {})`; `null` — `TypeError`, как в JS.
fn normalize_world(input: Option<&Value>) -> Result<Map<String, Value>, BootstrapError> {
    if matches!(input, Some(Value::Null)) {
        return Err(type_error("Cannot read properties of null (reading 'preset')"));
    }
    let mut world = Map::new();
    for (key, limit) in WORLD_FIELDS {
        world.insert(key.into(), string(clean(prop(input, key), limit)));
    }
    Ok(world)
}

fn world_text(world: &Map<String, Value>, key: &str) -> String {
    str_of(world.get(key))
}

/// `normalizeHero(input, index)`.
fn normalize_hero(input: &Value, index: usize) -> Result<Value, BootstrapError> {
    let source = Some(input);
    let id = clean(prop(source, "id"), 40);
    let character = clean(prop(source, "character"), 80);
    if !text::test(re!(r"^[a-z0-9-]{1,40}$", "i"), &id) {
        return Err(BootstrapError::error(format!("У героя {} некорректный id", index + 1)));
    }
    if character.is_empty() {
        return Err(BootstrapError::error(format!("У героя {} нет имени персонажа", index + 1)));
    }
    let field = |key: &str| prop(source, key);
    let or_text = |key: &str, limit: usize, fallback: &str| {
        let value = clean(field(key), limit);
        string(if value.is_empty() { fallback.to_string() } else { value })
    };
    let max_hp = integer(field("maxHp"), 10.0, 1.0, 999.0);
    let presentation = party_presentation_for(Some(&json!(index)));
    let portrait = clean(field("portrait"), 240);
    let mut hero = input.as_object().cloned().unwrap_or_default();
    let mut set = |key: &str, value: Value| {
        hero.insert(key.into(), value);
    };
    set("id", string(id));
    set("name", or_text("name", 80, "Свободный герой"));
    set("character", string(character.clone()));
    set("role", or_text("role", 120, "Искатель приключений · ур. 1"));
    set("species", or_text("species", 80, "Человек"));
    set("background", or_text("background", 120, "Странник"));
    for (key, limit) in [("backstory", 2000), ("traits", 500), ("ideals", 500), ("bonds", 500), ("flaws", 500), ("features", 1000), ("notes", 1000)] {
        set(key, string(clean(field(key), limit)));
    }
    set("level", num(integer(field("level"), 1.0, 1.0, 20.0)));
    set("speed", num(integer(field("speed"), 30.0, 5.0, 120.0)));
    set("proficiency", num(integer(field("proficiency"), 2.0, 2.0, 8.0)));
    set("hp", num(max_hp));
    set("maxHp", num(max_hp));
    set("armor", num(integer(field("armor"), 10.0, 1.0, 30.0)));
    set("online", Value::Bool(!js::is_false(field("online"))));
    set("inventory", match field("inventory") {
        Some(Value::Array(items)) => Value::Array(items.iter().take(100).cloned().collect()),
        _ => json!([]),
    });
    set("currency", if is_object_like(field("currency")) { field("currency").cloned().unwrap_or(Value::Null) } else { json!({ "copper": 0, "silver": 0, "gold": 0, "platinum": 0 }) });
    set(
        "abilities",
        if is_object_like(field("abilities")) { field("abilities").cloned().unwrap_or(Value::Null) } else { json!({ "str": 10, "dex": 10, "con": 10, "int": 10, "wis": 10, "cha": 10 }) },
    );
    let color = clean(field("color"), 20);
    set("color", if color.is_empty() { presentation.get("color").cloned().unwrap_or(Value::Null) } else { string(color) });
    let initials = clean(field("initials"), 4);
    set("initials", string(if initials.is_empty() { text::upper(&text::head(&character, 2)) } else { initials }));
    set("portrait", if portrait.is_empty() { presentation.get("portrait").cloned().unwrap_or(Value::Null) } else { string(portrait.clone()) });
    let position = clean(field("portraitPosition"), 40);
    set(
        "portraitPosition",
        if !position.is_empty() {
            string(position)
        } else if !portrait.is_empty() {
            string("50% 50%")
        } else {
            presentation.get("portraitPosition").cloned().unwrap_or(Value::Null)
        },
    );
    set("experience", num(integer(field("experience"), 0.0, 0.0, 9_999_999.0)));
    set("alignment", or_text("alignment", 100, "Не определено"));
    Ok(Value::Object(hero))
}

// --- запасной пролог ---------------------------------------------------------------

#[derive(Clone)]
struct FallbackTheme {
    location: String,
    theme: String,
    layout: String,
    danger: String,
    water: f64,
}

fn theme(location: &str, theme: &str, layout: &str, danger: &str, water: f64) -> FallbackTheme {
    FallbackTheme { location: location.into(), theme: theme.into(), layout: layout.into(), danger: danger.into(), water }
}

/// `fallbackTheme(world, entropy, inspiration)`.
fn fallback_theme(world: &Map<String, Value>, entropy: &str, inspiration: Option<&CampaignInspiration>) -> FallbackTheme {
    let value = lower(&format!("{} {} {} {}", world_text(world, "preset"), world_text(world, "era"), world_text(world, "genre"), world_text(world, "premise")));
    if let Some(region) = inspiration.and_then(|inspiration| inspiration.region) {
        if text::trim(&value).is_empty() {
            return theme(&capitalize(Some(&string(region.label))), region.theme, region.layout, region.danger, region.water);
        }
    }
    if text::test(re!(r"будущ|косм|кибер|зв[её]зд|станци|технолог", "u"), &value) {
        return theme("Кольцевая станция «Гелиос»", "футуристическая орбитальная станция", "rooms", "средняя", 0.0);
    }
    if text::test(re!(r"соврем|детектив|нуар|город", "u"), &value) {
        return theme("Ночной район Ривермарк", "современный город", "streets", "низкая", 0.03);
    }
    if text::test(re!(r"дик|постапок|пустош|выжив", "u"), &value) {
        return theme("Поселение у Разломанной трассы", "постапокалиптическая пустошь", "open", "высокая", 0.02);
    }
    if !text::trim(&value).is_empty() {
        return theme("Пограничный город Эйрхольм", "средневековый пограничный город", "streets", "средняя", 0.04);
    }
    let automatic = [
        theme("Пограничный город Эйрхольм", "средневековый пограничный город", "streets", "средняя", 0.04),
        theme("Кольцевая станция «Гелиос»", "футуристическая орбитальная станция", "rooms", "средняя", 0.0),
        theme("Ночной район Ривермарк", "современный мистический город", "streets", "низкая", 0.03),
        theme("Поселение у Разломанной трассы", "постапокалиптическая пустошь", "open", "высокая", 0.02),
    ];
    let source = if entropy.is_empty() { clock::now_ms().to_string() } else { entropy.to_string() };
    let index = hash::sha256(source.as_bytes())[0] as usize % automatic.len();
    automatic[index].clone()
}

const MAP_SCALES: [&str; 4] = ["room", "site", "stronghold", "region"];
const MAP_PATTERNS: [&str; 10] = ["small-room", "great-hall", "keep", "courtyard", "crypt", "temple", "cave-cluster", "village", "bridge", "natural"];
const MAP_MATERIALS: [&str; 8] = ["stone", "wood", "earth", "grass", "sand", "metal", "marble", "ice"];
const MAP_LAYOUTS: [&str; 7] = ["rooms", "streets", "open", "winding", "cavern", "ruins", "radial"];
const DANGERS: [&str; 3] = ["низкая", "средняя", "высокая"];

/// `startingVisualSpec(theme, world)`: `{ scale, pattern, material, width, height }`.
fn starting_visual_spec(theme: &FallbackTheme, world: &Map<String, Value>) -> Map<String, Value> {
    let value = lower(&format!("{} {} {} {}", theme.location, theme.theme, world_text(world, "startingLocation"), world_text(world, "openingSituation")));
    let has = |regex: &Regex| text::test(regex, &value);
    let spec = |scale: &str, pattern: &str, material: &str, width: i64, height: i64| {
        let mut map = Map::new();
        map.insert("scale".into(), string(scale));
        map.insert("pattern".into(), string(pattern));
        map.insert("material".into(), string(material));
        map.insert("width".into(), json!(width));
        map.insert("height".into(), json!(height));
        map
    };
    if has(re!(r"крепост|замок|цитадел", "u")) {
        return spec("stronghold", "keep", "stone", 23, 17);
    }
    if has(re!(r"комнат|кабинет|мал.*зал|кают", "u")) {
        let material = if has(re!(r"станци|косм|тех", "u")) {
            "metal"
        } else if has(re!(r"дом|таверн", "u")) {
            "wood"
        } else {
            "stone"
        };
        return spec("room", "small-room", material, 9, 7);
    }
    if theme.layout == "streets" {
        return spec("site", "village", if has(re!(r"станци|тех|кибер", "u")) { "metal" } else { "stone" }, 17, 11);
    }
    if theme.layout == "rooms" {
        return spec("site", "great-hall", if has(re!(r"станци|тех|косм", "u")) { "metal" } else { "stone" }, 15, 11);
    }
    if has(re!(r"лес|роща|луг", "u")) {
        return spec("site", "natural", "grass", 15, 11);
    }
    if has(re!(r"пустын|пес", "u")) {
        return spec("site", "natural", "sand", 15, 11);
    }
    spec("site", "natural", "earth", 15, 11)
}

/// `OPENING_THREAT_RE`: противник или нападение в словах владельца.
fn opening_threat() -> &'static Regex {
    re!(
        r"(?<![\p{L}])(?:(?:разбойн|бандит|грабител|налётчик|налетчик|мародёр|мародер|головорез|душегуб|убийц|пират|культист|сектант|наёмник|наемник|дезертир|чудовищ|монстр|нежит|мертвец|зомби|скелет|упыр|вурдалак|вампир|оборотн|гоблин|кобольд|гнолл|дракон|волч|засад|нападе|напада|напал|атаку|атаков)\p{L}*|(?:орк|огр|волк|тролл|демон|враг|твар)(?:а|у|ом|е|и|ы|ов|ам|ами|ах|ь|ей|ям|ями|ях)?)(?![\p{L}])",
        "iu"
    )
}

/// `fallbackSituationText(situation)`: угроза из вводных звучит молвой.
fn fallback_situation_text(situation: &str) -> String {
    if !text::test(opening_threat(), situation) {
        return situation.to_string();
    }
    format!(
        "Пока это только молва: „{}“ — своими глазами герои этого ещё не видели, и где правда, а где пересказ, предстоит выяснить.",
        text::replace_all(re!(r"[\s.!?…]+$", "u"), situation, "")
    )
}

/// `fallbackOpening({ name, partyName, world, heroes, entropy, inspiration })`.
fn fallback_opening(name: &str, party_name: &str, world: &Map<String, Value>, heroes: &[Value], entropy: &str, inspiration: Option<&CampaignInspiration>) -> Value {
    let theme = fallback_theme(world, entropy, inspiration);
    let starting = world_text(world, "startingLocation");
    let location = if starting.is_empty() { theme.location.clone() } else { starting };
    let sizes = ["одного", "двух", "трёх", "четырёх", "пяти"];
    let unnamed = sizes[heroes.len().clamp(1, 5) - 1];
    let hero_names = if heroes.iter().all(|hero| js::truthy(prop(Some(hero), "characterSetupRequired"))) {
        format!("{unnamed} {}", if heroes.len() == 1 { "героя, которому игрок ещё даст имя и прошлое" } else { "героев, которым игроки ещё дадут имена и прошлое" })
    } else {
        heroes.iter().map(|hero| js::s(prop(Some(hero), "character"))).collect::<Vec<_>>().join(", ")
    };
    let or = |value: String, fallback: &str| if value.is_empty() { fallback.to_string() } else { value };
    let era = or(world_text(world, "era"), "необычной авторской эпохе");
    let genre = {
        let own = world_text(world, "genre");
        let own = if own.is_empty() { world_text(world, "preset") } else { own };
        if own.is_empty() {
            inspiration.and_then(|inspiration| inspiration.genre_lean).filter(|lean| !lean.is_empty()).unwrap_or("приключенческой истории").to_string()
        } else {
            own
        }
    };
    let tone = or(world_text(world, "tone"), "Атмосфера полна тайн и обещает открытия");
    let premise = {
        let own = world_text(world, "premise");
        let seeded = match inspiration.and_then(|inspiration| inspiration.hook).filter(|hook| !hook.is_empty()) {
            Some(hook) => {
                let detail = match inspiration.and_then(|inspiration| inspiration.detail).filter(|detail| !detail.is_empty()) {
                    Some(detail) => format!("И ещё: {detail}."),
                    None => String::new(),
                };
                text::trim(&format!("{}. {detail}", capitalize(Some(&string(hook))))).to_string()
            }
            None => String::new(),
        };
        if !own.is_empty() {
            own
        } else if !seeded.is_empty() {
            seeded
        } else {
            "Привычный порядок нарушает событие, которое может навсегда изменить этот мир.".to_string()
        }
    };
    let situation = or(world_text(world, "openingSituation"), &premise);
    let visual = starting_visual_spec(&theme, world);
    let mut map = Map::new();
    map.insert("layout".into(), string(theme.layout.clone()));
    for (key, value) in visual {
        map.insert(key, value);
    }
    map.insert("openness".into(), json!(0.66));
    map.insert("water".into(), num(theme.water));
    map.insert("featureCount".into(), json!(6));
    json!({
        "campaignName": if name == "Новая кампания" { format!("Хроники: {location}") } else { name.to_string() },
        "partyName": if party_name == "Новый отряд" { "Искатели нового мира".to_string() } else { party_name.to_string() },
        "worldSummary": format!("{name} — самостоятельный мир в {era}, жанр: {genre}. {premise}"),
        "worldHistory": format!("Земли вокруг {location} менялись задолго до появления героев. {premise} Теперь старые дороги, границы и забытые места снова определяют судьбы тех, кто здесь живёт."),
        "worldMap": {},
        "openingNarration": format!("{location}. {tone}. {}\n\nЗдесь впервые сходятся пути героев: {hero_names}. У каждого есть причина не пройти мимо, но решение о первом шаге остаётся за отрядом.", fallback_situation_text(&situation)),
        "scene": {
            "title": "Точка пересечения", "location": location,
            "mood": tone,
            "objective": "Разобраться в происходящем и решить, кому можно доверять",
            "theme": theme.theme, "danger": theme.danger,
            "map": Value::Object(map),
        },
        "hook": situation,
        "npcs": [{
            "name": "Мира Ветрокрыл", "role": "проводница и очевидец",
            "summary": "Местная проводница знает дороги и следит за переменами вокруг.",
            "voice": "Говорит коротко, внимательно и по делу.",
            "goals": ["Защитить путников", "Понять источник угрозы"],
            "beliefs": ["Обещания важнее красивых слов"],
        }],
    })
}

// --- нормализация ответа модели и авторского шаблона ----------------------------

/// `normalizeOpeningNpcs(value, fallback, { authored })`.
fn normalize_opening_npcs(value: Option<&Value>, fallback: Option<&Value>, authored: bool) -> Value {
    let empty = Value::Object(Map::new());
    let normalized: Vec<Value> = list(value)
        .iter()
        .map(|entry| if is_plain(Some(entry)) { entry } else { &empty })
        .map(|entry| {
            let field = |key: &str| prop(Some(entry), key);
            let texts = |key: &str| -> Vec<Value> { list(field(key)).iter().map(|item| clean(Some(item), 160)).filter(|item| !item.is_empty()).take(4).map(Value::String).collect() };
            let clone_object = |key: &str| if authored && is_object_like(field(key)) { field(key).cloned().unwrap_or(Value::Null) } else { Value::Null };
            let visibility = js::string(field("visibility"));
            json!({
                "id": if authored { clean(field("id"), 120) } else { String::new() },
                "name": clean(field("name"), 80),
                "role": clean(field("role"), 120),
                "location": if authored { clean(field("location"), 180) } else { String::new() },
                "locationId": if authored { clean(nullish(field("location_id"), field("locationId")), 120) } else { String::new() },
                "summary": clean(field("summary"), 400),
                "voice": clean(field("voice"), 240),
                "factionId": clean(nullish(field("faction_id"), field("factionId")), 80),
                "goals": texts("goals"),
                "beliefs": texts("beliefs"),
                "speechProfile": clone_object("speech_profile"),
                "socialDcs": clone_object("social_dcs"),
                "inventory": if authored { match field("inventory") { Some(Value::Array(items)) => Value::Array(items.clone()), _ => json!([]) } } else { json!([]) },
                "tags": if authored { match field("tags") { Some(Value::Array(items)) => Value::Array(items.iter().map(|tag| clean(Some(tag), 60)).filter(|tag| !tag.is_empty()).take(20).map(Value::String).collect()), _ => json!([]) } } else { json!([]) },
                "visibility": if authored && ["public", "party", "gm_only"].contains(&visibility.as_str()) { visibility } else { "party".to_string() },
                "revealOnPresence": authored && js::is_true(field("reveal_on_presence")),
                "mechanics": clone_object("mechanics"),
            })
        })
        .filter(|entry| entry["name"].as_str().is_some_and(|name| !name.is_empty()))
        .take(if authored { 12 } else { 5 })
        .collect();
    if normalized.is_empty() {
        fallback.cloned().unwrap_or(Value::Null)
    } else {
        Value::Array(normalized)
    }
}

/// `normalizeOpeningCanon(value)`: короткие факты исходной ситуации — от
/// двенадцати знаков, без повторов, не больше шести.
pub fn normalize_opening_canon(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else { return Vec::new() };
    let mut unique: IndexSet<String> = IndexSet::new();
    for entry in items {
        let source = match entry {
            Value::String(_) => Some(entry),
            other => prop(Some(other), "fact"),
        };
        let fact = clean(source, 220);
        if text::len(&fact) >= 12 {
            unique.insert(fact);
        }
    }
    unique.into_iter().take(OPENING_CANON_LIMIT).collect()
}

fn member(value: Option<&Value>, set: &[&str]) -> Option<String> {
    match value {
        Some(Value::String(text)) if set.contains(&text.as_str()) => Some(text.clone()),
        _ => None,
    }
}

/// `normalizeOpening(input, fallback, { authored })`.
fn normalize_opening(input: &Value, fallback: &Value, authored: bool) -> Value {
    let empty = Value::Object(Map::new());
    let source = if is_plain(Some(input)) { input } else { &empty };
    let scene = prop(Some(source), "scene").filter(|scene| is_plain(Some(scene))).unwrap_or(&empty);
    let map = prop(Some(scene), "map").filter(|map| is_plain(Some(map))).unwrap_or(&empty);
    let f_scene = prop(Some(fallback), "scene");
    let f_map = prop(f_scene, "map");
    let f_number = |key: &str| js::number(prop(f_map, key));
    let world_rules = if authored {
        let rules = nullish(prop(Some(source), "worldRules"), prop(Some(source), "world_rules"));
        rules.filter(|rules| is_plain(Some(rules))).cloned()
    } else {
        None
    };
    let scale = member(prop(Some(map), "scale"), &MAP_SCALES).unwrap_or_else(|| str_of(prop(f_map, "scale")));
    let requested_theme = nullish(prop(Some(map), "theme_id"), prop(Some(map), "themeId"));
    let theme_id = match requested_theme {
        Some(Value::String(id)) if authored && SCENE_THEME_IDS.contains(id.as_str()) => id.clone(),
        _ => String::new(),
    };
    let (min_width, min_height) = match scale.as_str() {
        "stronghold" => (19.0, 13.0),
        "region" => (21.0, 15.0),
        "site" => (11.0, 9.0),
        _ => (7.0, 7.0),
    };
    let area = SIZE_CLASSES[1].1;
    let or_text = |value: String, fallback: Option<&Value>| if value.is_empty() { fallback.cloned().unwrap_or(Value::Null) } else { string(value) };
    let mut normalized_map = Map::new();
    normalized_map.insert("layout".into(), member(prop(Some(map), "layout"), &MAP_LAYOUTS).map(string).unwrap_or_else(|| prop(f_map, "layout").cloned().unwrap_or(Value::Null)));
    normalized_map.insert("scale".into(), string(scale.clone()));
    normalized_map.insert("pattern".into(), member(prop(Some(map), "pattern"), &MAP_PATTERNS).map(string).unwrap_or_else(|| prop(f_map, "pattern").cloned().unwrap_or(Value::Null)));
    normalized_map.insert("material".into(), member(prop(Some(map), "material"), &MAP_MATERIALS).map(string).unwrap_or_else(|| prop(f_map, "material").cloned().unwrap_or(Value::Null)));
    normalized_map.insert(
        "width".into(),
        num(integer(prop(Some(map), "width"), f_number("width"), min_width, if authored { area.max_width as f64 } else { 48.0 })),
    );
    normalized_map.insert(
        "height".into(),
        num(integer(prop(Some(map), "height"), f_number("height"), min_height, if authored { area.max_height as f64 } else { 40.0 })),
    );
    normalized_map.insert("openness".into(), num(decimal(prop(Some(map), "openness"), f_number("openness"), 0.35, 0.85)));
    normalized_map.insert("water".into(), num(decimal(prop(Some(map), "water"), f_number("water"), 0.0, 0.3)));
    normalized_map.insert("featureCount".into(), num(integer(prop(Some(map), "featureCount"), f_number("featureCount"), 2.0, 12.0)));
    if !theme_id.is_empty() {
        normalized_map.insert("theme_id".into(), string(theme_id));
    }
    let design = normalize_scene_map_design(prop(Some(map), "design").unwrap_or(&Value::Null));
    if design.as_object().is_some_and(|design| !design.is_empty()) {
        normalized_map.insert("design".into(), design);
    }
    let mut normalized_scene = Map::new();
    normalized_scene.insert("title".into(), or_text(clean(prop(Some(scene), "title"), 100), prop(f_scene, "title")));
    normalized_scene.insert("location".into(), or_text(clean(prop(Some(scene), "location"), 160), prop(f_scene, "location")));
    normalized_scene.insert("locationId".into(), string(clean(nullish(prop(Some(scene), "locationId"), prop(Some(scene), "location_id")), 120)));
    normalized_scene.insert("mood".into(), or_text(clean(prop(Some(scene), "mood"), 240), prop(f_scene, "mood")));
    normalized_scene.insert("objective".into(), or_text(clean(prop(Some(scene), "objective"), 240), prop(f_scene, "objective")));
    normalized_scene.insert("theme".into(), or_text(clean(prop(Some(scene), "theme"), 120), prop(f_scene, "theme")));
    normalized_scene.insert("danger".into(), member(prop(Some(scene), "danger"), &DANGERS).map(string).unwrap_or_else(|| prop(f_scene, "danger").cloned().unwrap_or(Value::Null)));
    if let Some(kind) = member(prop(Some(scene), "scene_kind"), &["settlement", "wilderness", "dungeon", "road", "other"]) {
        normalized_scene.insert("scene_kind".into(), string(kind));
    }
    if let Some(kind) = member(prop(Some(scene), "settlement_type"), &["village", "town", "city", "outpost", "traveling"]) {
        normalized_scene.insert("settlement_type".into(), string(kind));
    }
    normalized_scene.insert("map".into(), Value::Object(normalized_map));
    let mut opening = Map::new();
    opening.insert("campaignName".into(), or_text(clean(prop(Some(source), "campaignName"), 120), prop(Some(fallback), "campaignName")));
    opening.insert("partyName".into(), or_text(clean(prop(Some(source), "partyName"), 120), prop(Some(fallback), "partyName")));
    opening.insert("worldSummary".into(), or_text(clean(prop(Some(source), "worldSummary"), 1200), prop(Some(fallback), "worldSummary")));
    opening.insert("worldHistory".into(), or_text(prose(prop(Some(source), "worldHistory"), 5000), prop(Some(fallback), "worldHistory")));
    opening.insert(
        "worldMap".into(),
        prop(Some(source), "worldMap").filter(|value| is_plain(Some(value))).or_else(|| prop(Some(fallback), "worldMap")).cloned().unwrap_or(Value::Null),
    );
    opening.insert("openingNarration".into(), or_text(prose(prop(Some(source), "openingNarration"), 4000), prop(Some(fallback), "openingNarration")));
    opening.insert("scene".into(), Value::Object(normalized_scene));
    opening.insert("hook".into(), or_text(clean(prop(Some(source), "hook"), 500), prop(Some(fallback), "hook")));
    opening.insert("npcs".into(), normalize_opening_npcs(prop(Some(source), "npcs"), prop(Some(fallback), "npcs"), authored));
    opening.insert("secrets".into(), Value::Array(normalize_gm_secrets(prop(Some(source), "secrets"), 4)));
    opening.insert("canon".into(), json!(normalize_opening_canon(prop(Some(source), "canon"))));
    if let Some(rules) = world_rules {
        opening.insert("worldRules".into(), rules);
    }
    Value::Object(opening)
}

/// Факты канона: публичные, о стартовом месте; id — от текста.
fn opening_canon_facts(opening: &Value, location_entity: Option<&Value>, campaign_code: &str, recorded_at: &Value) -> Vec<Value> {
    if !js::truthy(prop(location_entity, "id")) {
        return Vec::new();
    }
    list(prop(Some(opening), "canon"))
        .iter()
        .enumerate()
        .map(|(index, summary)| {
            let id = text::head(&sha_hex(&format!("scene-canon\u{0}{campaign_code}\u{0}{index}\u{0}{}", js::string(Some(summary)))), 24);
            json!({
                "id": format!("fact:canon:{id}"),
                "subject_id": prop(location_entity, "id"),
                "predicate": "scene_canon",
                "object": "Установленный факт исходной ситуации",
                "summary": summary,
                "visibility": "party",
                "source_event_ids": [],
                "source_command_id": format!("campaign-bootstrap:{campaign_code}"),
                "supersedes_fact_id": "",
                "status": "active",
                "recorded_at_minutes": recorded_at,
            })
        })
        .collect()
}

/// Скрытые факты из заготовок ведущего.
fn opening_secret_facts(opening: &Value, location_entity: Option<&Value>, campaign_code: &str) -> Vec<Value> {
    if !js::truthy(prop(location_entity, "id")) {
        return Vec::new();
    }
    list(prop(Some(opening), "secrets"))
        .iter()
        .enumerate()
        .map(|(index, secret)| {
            gm_secret_fact(
                secret,
                &json!({
                    "subjectId": prop(location_entity, "id"),
                    "salt": campaign_code,
                    "index": index,
                    "sourceCommandId": format!("campaign-bootstrap:{campaign_code}"),
                }),
            )
        })
        .collect()
}

// --- старт внутри помещения ------------------------------------------------------

struct InteriorPlace {
    at: Regex,
    into: Regex,
    zone: Regex,
}

fn compile(pattern: &str, flags: &str) -> Regex {
    // Выражения — константы модуля, проверенные тестом.
    Regex::new(&text::js_regex_source(pattern, flags)).expect("регулярное выражение места")
}

static OPENING_INTERIOR_PLACES: LazyLock<Vec<InteriorPlace>> = LazyLock::new(|| {
    let inside = r"(?<!\p{L})(?:в|во)\s+(?:\p{L}+\s+){0,2}?";
    let end = r"(?!\p{L})";
    let place = |at: &str, into: &str, zone: &str| InteriorPlace {
        at: compile(&format!("{inside}(?:{at}){end}"), "u"),
        into: compile(&format!("{inside}(?:{into}){end}"), "u"),
        zone: compile(zone, "iu"),
    };
    vec![
        place(
            r"таверне|трактире|корчме|кабаке|харчевне|пивной|гостинице|постоялом\s+дворе|питейном\s+доме|общем\s+зале",
            r"таверну|трактир|корчму|кабак|харчевню|пивную|гостиницу|постоялый\s+двор|питейный\s+дом|общий\s+зал",
            r"таверн|трактир|постоял|питейн|гостев|корчм|харчевн|общий\s+зал",
        ),
        place(r"храме|святилище|часовне|церкви|соборе|монастыре|капище", r"храм|часовню|церковь|собор|монастырь", r"храм|святилищ|часовн|неф|притвор|алтарн|собор|монастыр"),
        place(r"лавке|мастерской|кузнице|аптеке", r"лавку|мастерскую|кузницу|аптеку", r"лавк|торгов|мастерск|кузн|аптек"),
        place(r"усадьбе|особняке|ратуше|доме\s+старосты", r"усадьбу|особняк|ратушу|дом\s+старосты", r"усадьб|старост|резиденц|контор|парадн|ратуш"),
        place(r"амбаре|конюшне|сарае|хлеву|хлеве", r"амбар|конюшню|сарай|хлев", r"амбар|конюшн|скотн|сара"),
    ]
});

fn opening_entering_verb() -> &'static Regex {
    re!(r"(?<!\p{L})(?:заш[её]?л|зашл|заход|вош[её]?л|вошл|вход|вбега|вбежа|ввалива|ввали|забега|забежа|прячут|спрята|укрыва|укрыл)\p{L}*", "u")
}

fn opening_outside_sentence() -> &'static Regex {
    re!(
        r"(?<!\p{L})(?:снаружи|у\s+входа|у\s+двер\p{L}*|перед\s+(?:\p{L}+\s+)?(?:таверн|трактир|храм|лавк|усадьб|амбар|дом)\p{L}*|вчера|накануне|назад|когда-то|прежде|раньше|слух\p{L}*|говорят|помн\p{L}*)(?!\p{L})",
        "u"
    )
}

fn first_index(regex: &Regex, value: &str) -> Option<usize> {
    regex.find(value).ok().flatten().map(|found| found.start())
}

/// `openingInteriorPlace(texts)`: вид помещения, в котором вводные застают
/// героев.
fn opening_interior_place(texts: &[String]) -> Option<&'static InteriorPlace> {
    for value in texts {
        let unquoted = text::replace_all(re!(r"«[^»]{0,200}»", "gu"), value, " ");
        let sentences = split_re(re!(r"(?<=[.!?…])\s+", "u"), &lower(&clean_str(&unquoted, 2_000)));
        for sentence in sentences {
            if text::test(opening_outside_sentence(), &sentence) {
                continue;
            }
            let mut best: Option<(&'static InteriorPlace, usize)> = None;
            for place in OPENING_INTERIOR_PLACES.iter() {
                let found = first_index(&place.at, &sentence).or_else(|| if text::test(opening_entering_verb(), &sentence) { first_index(&place.into, &sentence) } else { None });
                if let Some(at) = found {
                    if best.is_none_or(|(_, best_at)| at < best_at) {
                        best = Some((place, at));
                    }
                }
            }
            if let Some((place, _)) = best {
                return Some(place);
            }
        }
    }
    None
}

/// `openingInteriorAnchor(map, texts)`: клетка, от которой отряд
/// рассаживается внутри заказанного помещения.
fn opening_interior_anchor(map: &TacticalMap, texts: &[String]) -> Option<(i64, i64)> {
    let place = opening_interior_place(texts)?;
    let spawn = map.spawn_points.iter().find(|point| point.role == "party");
    let interior: IndexSet<&str> = map.zones.iter().filter(|zone| zone.kind == "interior" && !zone.label.is_empty()).map(|zone| zone.id.as_str()).collect();
    if let Some(spawn) = spawn {
        let zone = cell_at(map, spawn.x, spawn.y).map(|cell| cell.zone).unwrap_or("");
        if interior.contains(zone) {
            return None;
        }
    }
    let occupied: IndexSet<(i64, i64)> = map.props.iter().flat_map(|prop| prop.footprint.iter()).map(|cell| (cell.x, cell.y)).collect();
    let mut free: IndexMap<String, Vec<(i64, i64)>> = IndexMap::new();
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(cell) = cell_at(map, x, y) else { continue };
            if !cell.passable || !interior.contains(cell.zone) || cell.surface == "water" || occupied.contains(&(x, y)) {
                continue;
            }
            free.entry(cell.zone.to_string()).or_default().push((x, y));
        }
    }
    let count = |id: &str| free.get(id).map_or(0, Vec::len);
    let roomiest = |mut ids: Vec<String>| -> Option<String> {
        ids.sort_by(|left, right| count(right).cmp(&count(left)).then_with(|| text::locale_compare(left, right)));
        ids.into_iter().next()
    };
    let labelled: Vec<String> = map.zones.iter().filter(|zone| interior.contains(zone.id.as_str()) && text::test(&place.zone, &zone.label)).map(|zone| zone.id.clone()).collect();
    let whole_building = map.theme == "building" || map.theme == "temple";
    let zone_id = roomiest(labelled).or_else(|| if whole_building { roomiest(free.keys().cloned().collect()) } else { None });
    let room = zone_id.filter(|id| !id.is_empty()).and_then(|id| free.get(&id).cloned()).unwrap_or_default();
    if room.is_empty() {
        return None;
    }
    let cx = room.iter().map(|cell| cell.0 as f64).sum::<f64>() / room.len() as f64;
    let cy = room.iter().map(|cell| cell.1 as f64).sum::<f64>() / room.len() as f64;
    let distance = |cell: &(i64, i64)| (cell.0 as f64 - cx).abs() + (cell.1 as f64 - cy).abs();
    let mut sorted = room;
    sorted.sort_by(|left, right| distance(left).partial_cmp(&distance(right)).unwrap_or(std::cmp::Ordering::Equal).then(left.0.cmp(&right.0)).then(left.1.cmp(&right.1)));
    sorted.into_iter().next()
}

fn cell_xy(cell: &Value) -> (i64, i64) {
    (js::number(cell.get("x")) as i64, js::number(cell.get("y")) as i64)
}

/// `startingCells(cells, count, { anchorFeatures, map, origin })`.
fn starting_cells(cells: &[Value], count: usize, anchor_features: &[&str], map: &TacticalMap, origin: Option<(i64, i64)>) -> Result<Vec<(i64, i64)>, BootstrapError> {
    let occupied: IndexSet<(i64, i64)> = map.props.iter().flat_map(|prop| prop.footprint.iter()).map(|cell| (cell.x, cell.y)).collect();
    let spawn = origin.or_else(|| map.spawn_points.iter().find(|point| point.role == "party").map(|point| (point.x, point.y)));
    let reached = spawn.map(|(x, y)| reachable_cells(map, x, y, false, None));
    let mut floors: Vec<(i64, i64)> = cells
        .iter()
        .filter(|cell| {
            let xy = cell_xy(cell);
            js::truthy(cell.get("revealed"))
                && cell.get("type").and_then(Value::as_str) == Some("floor")
                && !js::truthy(cell.get("feature"))
                && !occupied.contains(&xy)
                && reached.as_ref().is_none_or(|reached| reached.contains(&xy))
        })
        .map(cell_xy)
        .collect();
    floors.sort();
    let anchor = spawn.or_else(|| {
        cells.iter().find(|cell| cell.get("feature").and_then(Value::as_str).is_some_and(|feature| anchor_features.contains(&feature))).map(cell_xy)
    });
    if let Some((ax, ay)) = anchor {
        let distance = |cell: &(i64, i64)| (cell.0 - ax).abs() + (cell.1 - ay).abs();
        floors.sort_by(|left, right| distance(left).cmp(&distance(right)).then(left.0.cmp(&right.0)).then(left.1.cmp(&right.1)));
    }
    if floors.len() < count {
        return Err(BootstrapError::error("В начальной области недостаточно свободных клеток для всего отряда"));
    }
    // Связность пола не видит мебель: ближайшая связная область после
    // учёта реквизита, карта не меняется.
    let blocked: std::collections::HashSet<(i64, i64)> = map.props.iter().filter(|prop| prop.blocks_move).flat_map(|prop| prop.footprint.iter()).map(|cell| (cell.x, cell.y)).collect();
    let mut checked: std::collections::HashSet<(i64, i64)> = std::collections::HashSet::new();
    for floor in &floors {
        if checked.contains(floor) {
            continue;
        }
        let accessible = reachable_cells(map, floor.0, floor.1, false, Some(&blocked));
        checked.extend(accessible.iter().copied());
        let group: Vec<(i64, i64)> = floors.iter().filter(|cell| accessible.contains(*cell)).copied().collect();
        if group.len() >= count && accessible.len() > count {
            return Ok(group.into_iter().take(count).collect());
        }
    }
    Err(BootstrapError::error("В начальной области нет связного места для отряда со свободным выходом"))
}

// --- пауза повтора -----------------------------------------------------------------

/// `new Promise((resolve) => setTimeout(resolve, ms))` без рантайма: таймер —
/// отдельный поток, будит задачу по истечении срока.
struct Pause {
    milliseconds: f64,
    state: Arc<Mutex<(bool, Option<Waker>)>>,
    started: bool,
}

impl Future for Pause {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        if self.milliseconds <= 0.0 {
            return Poll::Ready(());
        }
        {
            let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.0 {
                return Poll::Ready(());
            }
            state.1 = Some(context.waker().clone());
        }
        if !self.started {
            self.started = true;
            let state = Arc::clone(&self.state);
            let duration = std::time::Duration::from_secs_f64(self.milliseconds / 1000.0);
            std::thread::spawn(move || {
                std::thread::sleep(duration);
                let mut state = state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                state.0 = true;
                if let Some(waker) = state.1.take() {
                    waker.wake();
                }
            });
        }
        Poll::Pending
    }
}

fn pause(milliseconds: f64) -> Pause {
    Pause { milliseconds, state: Arc::new(Mutex::new((false, None))), started: false }
}

// --- создатель кампании ------------------------------------------------------------

/// Бросок зерна вдохновения по нормализованному миру (`drawCampaignInspiration({
/// world, diceService })`). Ошибка — исключение костей.
pub type InspirationDraw = dyn FnMut(&Value) -> Result<CampaignInspiration, BootstrapError> + Send;

/// `CampaignBootstrapper`.
pub struct CampaignBootstrapper {
    llm_client: Option<Arc<dyn LlmClient>>,
    lore_author: Option<LoreAuthor>,
    draw_inspiration: Option<Mutex<Box<InspirationDraw>>>,
    retry_pause_ms: f64,
}

impl Default for CampaignBootstrapper {
    fn default() -> Self {
        Self::new(None, None, None, None)
    }
}

impl CampaignBootstrapper {
    /// `new CampaignBootstrapper({ llmClient, loreAuthor, diceService,
    /// retryPauseMs })`. `draw_inspiration` `None` — без костей (первый
    /// элемент каждого пула), `retry_pause_ms` `None` — пять секунд.
    pub fn new(llm_client: Option<Arc<dyn LlmClient>>, lore_author: Option<LoreAuthor>, draw_inspiration: Option<Box<InspirationDraw>>, retry_pause_ms: Option<&Value>) -> Self {
        let pause = match retry_pause_ms {
            None => CAMPAIGN_BOOTSTRAP_RETRY_PAUSE_MS,
            some => {
                let number = js::number(some);
                if number.is_nan() || number == 0.0 {
                    0.0
                } else {
                    number.max(0.0)
                }
            }
        };
        Self { llm_client, lore_author, draw_inspiration: draw_inspiration.map(Mutex::new), retry_pause_ms: pause }
    }

    fn inspiration(&self, world: &Value) -> Result<CampaignInspiration, BootstrapError> {
        match &self.draw_inspiration {
            Some(draw) => {
                let mut draw = draw.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                draw(world)
            }
            None => draw_campaign_inspiration(Some(world), None).map_err(|error| BootstrapError::new("RangeError", None, error.to_string())),
        }
    }

    /// `create({ code, name, partyName, world, worldTemplateId, players,
    /// merchants, rulesetId, startLevel, campaignMode })`: состояние новой
    /// кампании (форма JS) или исключение JS.
    pub async fn create(&self, input: &Value) -> Result<Value, BootstrapError> {
        if input.is_null() {
            return Err(type_error("Cannot destructure property 'code' of 'object null' as it is null."));
        }
        let arg = |key: &str| prop(Some(input), key);
        let campaign_code = text::upper(&clean(arg("code"), 24));
        let campaign_name = {
            let name = clean(arg("name"), 120);
            if name.is_empty() { "Новая кампания".to_string() } else { name }
        };
        let group_name = {
            let name = clean(arg("partyName"), 120);
            if name.is_empty() { "Новый отряд".to_string() } else { name }
        };
        if !text::test(re!(r"^[A-Z0-9-]{3,24}$"), &campaign_code) {
            return Err(BootstrapError::error("Некорректный код кампании"));
        }
        let raw_players = match arg("players") {
            Some(Value::Array(items)) if (1..=12).contains(&items.len()) => items,
            _ => return Err(BootstrapError::error("Для новой кампании выберите от 1 до 12 героев")),
        };
        // Режим проверяется до любого вызова модели.
        let selected_mode = validate_campaign_mode(match arg("campaignMode") {
            None => None,
            some => some,
        })
        .map_err(|error| BootstrapError::new("Error", Some(error.code), error.message))?;
        let mode = str_of(Some(&selected_mode));
        let start_level = starting_level(nullish(arg("start_level"), arg("startLevel")))?;
        let ruleset_id = js::s(nullish(arg("ruleset_id"), arg("rulesetId")));
        let selected_ruleset = ruleset_lock(&ruleset_id, ProfileOptions { fallback: Some(LEGACY_DEFAULT_RULESET_ID), require_creation: true })
            .map_err(|error| BootstrapError::new("RulesetSelectionError", Some(error.code), error.message))?;
        let ruleset_value = str_of(selected_ruleset.get("ruleset_id"));
        // Как `rawPlayers.map(normalizeHero).map(…)`: сначала нормализуются
        // все герои, затем каждому — стартовый набор.
        let mut normalized = Vec::new();
        for (index, raw) in raw_players.iter().enumerate() {
            normalized.push(normalize_hero(raw, index)?);
        }
        let mut heroes = Vec::new();
        for hero in normalized {
            let hero = if js::truthy(hero.get("characterSetupRequired")) {
                hero
            } else {
                let options = StarterKitOptions { ruleset_id: ruleset_value.clone(), starter_policy_id: Some(STARTER_KIT_2024_POLICY.policy_id.to_string()), ..StarterKitOptions::default() };
                with_starter_kit(Some(&hero), &options).map_err(|error| type_error(error.to_string()))?
            };
            heroes.push(hero);
        }
        let ids: IndexSet<String> = heroes.iter().map(|hero| js::string(hero.get("id"))).collect();
        if ids.len() != heroes.len() {
            return Err(BootstrapError::error("В кампании повторяются id героев"));
        }
        let requested_template = clean(nullish(arg("world_template_id"), arg("worldTemplateId")), 80);
        let world_template = if requested_template.is_empty() { None } else { Some(get_world_template(Some(&string(requested_template)))?) };
        let owner_world = normalize_world(arg("world"))?;
        let world = match &world_template {
            Some(template) => {
                let mut world = normalize_world(prop(Some(template), "world"))?;
                let own = world_text(&owner_world, "boundaries");
                let boundaries = if own.is_empty() { clean(prop(prop(Some(template), "world"), "boundaries"), 500) } else { own };
                world.insert("boundaries".into(), string(boundaries));
                world
            }
            None => owner_world,
        };
        let world_value = Value::Object(world.clone());
        let inspiration = if world_template.is_some() { None } else { Some(self.inspiration(&world_value)?) };
        let hero_values = heroes.clone();
        let fallback = fallback_opening(&campaign_name, &group_name, &world, &hero_values, &campaign_code, inspiration.as_ref());
        let mut opening = match &world_template {
            Some(template) => normalize_opening(&world_template_opening(Some(template), &json!({ "campaignName": campaign_name, "partyName": group_name }))?, &fallback, true),
            None => fallback.clone(),
        };
        let mut generated_by = if world_template.is_some() { "authored-world-template" } else { "local-storyteller" };
        let template_label = match &world_template {
            Some(template) => format!("{}@{}", js::string(template.get("id")), js::string(template.get("version"))),
            None => String::new(),
        };
        let seed_source = json!({
            "campaignCode": campaign_code,
            "world": world_value,
            "worldTemplate": template_label,
            "heroes": heroes.iter().map(|hero| hero.get("id").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(),
        });
        let seed = text::head(&sha_hex(&js::stringify(&seed_source)), 24);
        let seed12 = text::head(&seed, 12);
        let requested_canon = if world_template.is_some() { None } else { Some(requested_opening_canon(Some(&world_value))) };
        let start_canon = campaign_start_canon(Some(&string(seed.clone())), requested_canon.as_ref());
        let start_minutes = start_canon.get("elapsed_minutes").cloned().unwrap_or(Value::Null);
        let mut start_mechanics = Map::new();
        if js::number(Some(&start_minutes)) > 0.0 {
            start_mechanics.insert("world_time".into(), json!({ "amount": start_minutes, "unit": "minute", "elapsed_minutes": start_minutes }));
        }
        if let Some(pin) = start_canon.get("weather_pin").filter(|pin| js::truthy(Some(pin))) {
            start_mechanics.insert("weather_pins".into(), json!([pin]));
        }
        let start_mechanics = Value::Object(start_mechanics);
        if let (Some(client), None) = (&self.llm_client, &world_template) {
            let started_at = clock::now_ms();
            let mut setup = Map::new();
            setup.insert("campaign".into(), string(campaign_name.clone()));
            setup.insert("party".into(), string(group_name.clone()));
            setup.insert("party_size".into(), json!(heroes.len()));
            setup.insert("starting_level".into(), json!(start_level));
            setup.insert("world".into(), world_value.clone());
            let prompt_heroes: Vec<Value> = heroes
                .iter()
                .map(|hero| {
                    let mut card = Map::new();
                    for key in ["character", "role", "species", "background", "backstory", "traits", "ideals", "bonds", "flaws"] {
                        if let Some(value) = hero.get(key) {
                            card.insert(key.into(), value.clone());
                        }
                    }
                    Value::Object(card)
                })
                .collect();
            setup.insert("heroes".into(), Value::Array(prompt_heroes));
            let mut sections = Map::new();
            sections.insert("campaign_setup".into(), Value::Object(setup));
            if let Some(seed) = inspiration_prompt_seed(inspiration.as_ref()) {
                sections.insert("inspiration_seed".into(), seed);
            }
            let time = start_canon.get("time");
            let mut clock_section = Map::new();
            for (key, source) in [("day", "day"), ("clock", "clock"), ("time_of_day", "phase"), ("time_of_day_label", "phase_label")] {
                if let Some(value) = prop(time, source) {
                    clock_section.insert(key.into(), value.clone());
                }
            }
            sections.insert("starting_world_clock".into(), Value::Object(clock_section));
            let mut weather = Map::new();
            if let Some(Value::Object(by_biome)) = start_canon.get("weather_by_biome") {
                for (biome, entry) in js::entries(by_biome) {
                    weather.insert(biome.clone(), string(format!("{}. {}", js::string(entry.get("label")), js::string(entry.get("summary")))));
                }
            }
            sections.insert("starting_weather_by_biome".into(), Value::Object(weather));
            let base_request = json!({
                "messages": [
                    { "role": "system", "content": CAMPAIGN_CREATOR_PROMPT },
                    { "role": "user", "content": build_data_only_context(Some(&Value::Object(sections))) },
                ],
                "temperature": 0.8,
                "maxTokens": 4800,
            });
            let mut attempt = 0;
            while attempt < 2 && generated_by != "ai-storyteller" {
                let remaining = CAMPAIGN_BOOTSTRAP_TIMEOUT_MS - (clock::now_ms() - started_at);
                if remaining < CAMPAIGN_BOOTSTRAP_RETRY_MINIMUM_MS {
                    break;
                }
                let mut request = base_request.clone();
                if let Value::Object(map) = &mut request {
                    map.insert("timeoutMs".into(), json!(if attempt == 0 { CAMPAIGN_BOOTSTRAP_TIMEOUT_MS } else { remaining }));
                }
                // Через сам объект клиента: обёртка `Arc` переопределённый `complete_json` не пробрасывает.
                match (**client).complete_json(&request, &json!({})).await {
                    Ok(result) => {
                        opening = normalize_opening(&result, &fallback, false);
                        generated_by = "ai-storyteller";
                    }
                    Err(error) => {
                        let code = error.code.clone().unwrap_or_default();
                        if !CAMPAIGN_BOOTSTRAP_RETRY_CODES.contains(&code.as_str()) {
                            break;
                        }
                        pause(self.retry_pause_ms).await;
                    }
                }
                attempt += 1;
            }
        }
        self.finish(Finish {
            campaign_code,
            campaign_name,
            group_name,
            mode,
            start_level,
            selected_ruleset,
            heroes,
            world,
            world_template,
            opening,
            generated_by,
            seed,
            seed12,
            start_minutes,
            start_mechanics,
            merchants: arg("merchants").cloned(),
        })
        .await
    }

    async fn finish(&self, input: Finish) -> Result<Value, BootstrapError> {
        let Finish {
            campaign_code,
            campaign_name,
            group_name,
            mode,
            start_level,
            selected_ruleset,
            heroes,
            world,
            world_template,
            opening,
            generated_by,
            seed,
            seed12,
            start_minutes,
            start_mechanics,
            merchants: raw_merchants,
        } = input;
        let scene = opening.get("scene").cloned().unwrap_or(Value::Null);
        let scene_field = |key: &str| scene.get(key).cloned().unwrap_or(Value::Null);
        let scene_location = str_of(scene.get("location"));
        // У авторского мира со сценарием арку задаёт сюжет.
        let template_id = world_template.as_ref().map(|template| js::s(template.get("id")));
        let scenario = template_id.as_deref().and_then(scenario_for_world_template);
        let arc = if mode != "adventure" {
            None
        } else {
            Some(match scenario {
                Some(scenario) => build_scenario_arc_plan(scenario),
                None => build_campaign_arc_plan(Some(&string(seed.clone())), None),
            })
        };
        // Пролог — необязательное украшение; отказ летописца кампанию не задерживает.
        let prologue = match (&self.lore_author, &world_template) {
            (Some(author), None) => author
                .compose_prologue(&json!({
                    "campaign": campaign_name,
                    "worldSummary": opening.get("worldSummary"),
                    "worldHistory": opening.get("worldHistory"),
                    "heroes": heroes,
                }))
                .await
                .map_err(|error| BootstrapError::new(error.name, None, error.message))?,
            _ => String::new(),
        };
        let mut concept = match &world_template {
            Some(template) => match world_template_concept(Some(template))? {
                Value::Object(map) => map,
                _ => Map::new(),
            },
            None => Map::new(),
        };
        for (key, value) in &world {
            concept.insert(key.clone(), value.clone());
        }
        concept.insert("worldSummary".into(), opening.get("worldSummary").cloned().unwrap_or(Value::Null));
        concept.insert("worldHistory".into(), opening.get("worldHistory").cloned().unwrap_or(Value::Null));
        if !prologue.is_empty() {
            concept.insert("prologue".into(), string(prologue));
        }
        concept.insert("generatedBy".into(), string(generated_by));
        concept.insert("campaign_mode".into(), string(mode.clone()));
        if let Some(arc) = &arc {
            concept.insert("arc".into(), arc.clone());
        }
        if mode == "persistent" {
            concept.insert("story_sequence".into(), json!(0));
            concept.insert("story_history".into(), json!([]));
        }
        let concept_value = Value::Object(concept.clone());
        let display_name = if campaign_name == "Новая кампания" { opening.get("campaignName").cloned().unwrap_or(Value::Null) } else { string(campaign_name.clone()) };
        let mut world_map_input = Map::new();
        world_map_input.insert("seed".into(), string(seed.clone()));
        world_map_input.insert("campaignName".into(), display_name.clone());
        world_map_input.insert("concept".into(), concept_value.clone());
        if let Some(source) = opening.get("worldMap") {
            world_map_input.insert("source".into(), source.clone());
        }
        if let Some(location) = scene.get("location") {
            world_map_input.insert("startingLocation".into(), location.clone());
        }
        if let Some(location_id) = scene.get("locationId") {
            world_map_input.insert("startingLocationId".into(), location_id.clone());
        }
        let campaign_world_map = create_campaign_world_map(&Value::Object(world_map_input)).map_err(type_error)?;
        let current_location_id = campaign_world_map.get("currentLocationId").cloned().unwrap_or(Value::Null);
        let authored_world_map = !list(prop(opening.get("worldMap"), "locations")).is_empty();
        let starting_world_kind = if authored_world_map {
            js::s(list(campaign_world_map.get("locations")).iter().find(|location| location.get("id") == Some(&current_location_id)).and_then(|location| location.get("kind")))
        } else {
            String::new()
        };
        let scene_seed = match &world_template {
            Some(template) => format!("authored-scene:{}@{}", js::string(template.get("id")), js::string(template.get("version"))),
            None => seed.clone(),
        };
        let place_context = if authored_world_map {
            world_location_design_context(&campaign_world_map, Some(&current_location_id), scene.get("location"))
        } else {
            sk_scene_base::scene_map_design::LocationDesignContext { description: String::new(), biome: String::new() }
        };
        // Что пролог пообещал увидеть на месте — только слова, которые читает игрок.
        let requirement_texts = json!([
            scene_field("location"),
            scene_field("theme"),
            scene_field("title"),
            scene_field("mood"),
            scene_field("objective"),
            world.get("startingLocation").cloned().unwrap_or(Value::Null),
            opening.get("openingNarration").cloned().unwrap_or(Value::Null),
        ]);
        let npcs = list(opening.get("npcs")).to_vec();
        let resident_npcs: Vec<Value> = npcs
            .iter()
            .filter(|npc| !js::truthy(prop(Some(npc), "location")) || lower(&js::s(prop(Some(npc), "location"))) == lower(&scene_location))
            .cloned()
            .collect();
        let landmarks = prop(prop(scene.get("map"), "design"), "landmarks");
        let map_requirements = scene_map_requirements_for(&requirement_texts, Some(&Value::Array(resident_npcs)), landmarks).map(|program| program.to_value());
        let joined = |parts: [Option<&Value>; 4], limit: usize| {
            let texts: Vec<String> = parts.iter().filter_map(|part| match part {
                Some(Value::String(text)) => Some(text.clone()),
                _ => None,
            }).collect();
            text::head(&texts.join(" "), limit)
        };
        let place_description = string(place_context.description.clone());
        let description = joined([Some(&place_description), scene.get("title"), scene.get("mood"), world.get("startingLocation")], 2000);
        let world_description = joined([concept.get("worldSummary"), concept.get("premise"), concept.get("setting"), concept.get("description")], 2400);
        let location_id_for_geometry = if js::truthy(Some(&current_location_id)) { current_location_id.clone() } else { scene_field("location") };
        let mut geometry_input = Map::new();
        geometry_input.insert("seed".into(), string(scene_seed));
        for (key, source) in [("theme", "theme"), ("danger", "danger"), ("location", "location")] {
            if let Some(value) = scene.get(source) {
                geometry_input.insert(key.into(), value.clone());
            }
        }
        geometry_input.insert("locationId".into(), location_id_for_geometry);
        geometry_input.insert("worldKind".into(), string(starting_world_kind.clone()));
        if let Some(kind) = scene.get("scene_kind") {
            geometry_input.insert("sceneKind".into(), kind.clone());
        }
        if let Some(kind) = scene.get("settlement_type") {
            geometry_input.insert("settlementType".into(), kind.clone());
        }
        geometry_input.insert("description".into(), string(description));
        geometry_input.insert("biome".into(), string(place_context.biome.clone()));
        geometry_input.insert("worldDescription".into(), string(world_description));
        if let Some(map) = scene.get("map") {
            geometry_input.insert("map".into(), map.clone());
        }
        geometry_input.insert("useLibrary".into(), Value::Bool(world_template.is_none()));
        geometry_input.insert("requirements".into(), map_requirements.as_ref().and_then(|program| program.get("items").cloned()).unwrap_or_else(|| json!([])));
        geometry_input.insert("program".into(), map_requirements.clone().unwrap_or(Value::Null));
        geometry_input.insert("entrySide".into(), string(opening_entry_side(Some(&campaign_world_map), Some(&current_location_id))));
        let mut geometry = generate_scene_geometry(&Value::Object(geometry_input))?;
        let cells = geometry.cells.clone();
        // Старт там, где вводные застали героев; иначе — у точки входа.
        let interior_origin = if world_template.is_some() {
            None
        } else {
            let narration = prose(opening.get("openingNarration"), 4_000);
            let first_paragraph = split_re(re!(r"\n{2,}", "u"), &narration).into_iter().next().unwrap_or_default();
            opening_interior_anchor(&geometry.map, &[world_text(&world, "openingSituation"), first_paragraph])
        };
        let mut positions = None;
        if let Some(origin) = interior_origin {
            positions = starting_cells(&cells, heroes.len(), &[], &geometry.map, Some(origin)).ok();
        }
        let positions = match positions {
            Some(positions) => positions,
            None => {
                let features: &[&str] = if world_template.is_some() { &["table_small", "market_stall", "well", "water_trough"] } else { &[] };
                starting_cells(&cells, heroes.len(), features, &geometry.map, None)?
            }
        };
        let positioned_heroes: Vec<Value> = heroes
            .iter()
            .zip(&positions)
            .map(|(hero, (x, y))| {
                let mut hero = hero.as_object().cloned().unwrap_or_default();
                hero.insert("x".into(), json!(x));
                hero.insert("y".into(), json!(y));
                Value::Object(hero)
            })
            .collect();
        let merchants = match &raw_merchants {
            Some(Value::Array(items)) if !items.is_empty() => normalize_merchants(raw_merchants.as_ref()),
            _ => normalize_merchants(Some(&json!([create_starter_merchant(Some(&json!({ "location": scene_field("location") })))]))),
        };
        // Фракции шаблона мира.
        let raw_factions: Vec<Value> = list(concept.get("factions")).iter().take(8).cloned().collect();
        let id_owner = template_id.clone().unwrap_or_else(|| seed12.clone());
        let mut faction_ids: IndexMap<String, String> = IndexMap::new();
        for (index, faction) in raw_factions.iter().enumerate() {
            let slug = lower(&clean(prop(Some(faction), "id"), 60));
            let slug = text::replace_all(re!(r"[^a-z0-9-]+", "gu"), &slug, "-");
            let slug = text::replace_all(re!(r"^-+|-+$", "gu"), &slug, "");
            let local = if slug.is_empty() { format!("group-{}", index + 1) } else { slug };
            faction_ids.insert(clean(prop(Some(faction), "id"), 80), text::head(&format!("faction-{id_owner}-{local}"), 120));
        }
        let faction_entities: Vec<Value> = if raw_factions.is_empty() {
            vec![json!({
                "id": format!("faction-{seed12}"), "kind": "faction", "name": "Хранители дороги",
                "summary": "Небольшое объединение проводников и дозорных, защищающее пути между поселениями.",
                "aliases": [], "visibility": "party", "tags": ["starter-faction"],
            })]
        } else {
            raw_factions
                .iter()
                .map(|faction| {
                    let summary = clean(prop(Some(faction), "summary"), 500);
                    let goal = clean(prop(Some(faction), "goal"), 300);
                    let goal = if goal.is_empty() { String::new() } else { format!("Цель: {goal}") };
                    let summary = [summary, goal].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
                    let mut entity = Map::new();
                    if let Some(id) = faction_ids.get(&clean(prop(Some(faction), "id"), 80)) {
                        entity.insert("id".into(), string(id.clone()));
                    }
                    entity.insert("kind".into(), string("faction"));
                    entity.insert("name".into(), string(clean(prop(Some(faction), "name"), 120)));
                    entity.insert("summary".into(), string(summary));
                    entity.insert("aliases".into(), json!([]));
                    entity.insert("visibility".into(), string("party"));
                    entity.insert("tags".into(), json!(["world-template-faction", format!("world-template:{}", template_id.clone().unwrap_or_default())]));
                    Value::Object(entity)
                })
                .collect()
        };
        let starter_faction_id = faction_entities.first().and_then(|entity| entity.get("id")).cloned().unwrap_or(Value::Null);
        let starter_quest_id = format!("quest-{seed12}");
        if mode == "persistent" {
            concept.insert("story_quest_id".into(), string(starter_quest_id.clone()));
        }
        let concept_value = Value::Object(concept.clone());
        let night_visitors: IndexSet<String> = scenario_night_visitor_ids(scenario).into_iter().collect();
        let mut opening_npcs: Vec<Map<String, Value>> = npcs
            .iter()
            .enumerate()
            .map(|(index, npc)| {
                let field = |key: &str| prop(Some(npc), key);
                let or_value = |key: &str, fallback: Value| if js::truthy(field(key)) { field(key).cloned().unwrap_or(Value::Null) } else { fallback };
                let mut entry = Map::new();
                entry.insert("id".into(), or_value("id", string(format!("npc-{seed12}-{}", index + 1))));
                entry.insert("name".into(), field("name").cloned().unwrap_or(Value::Null));
                if field("name").is_none() {
                    entry.shift_remove("name");
                }
                entry.insert("role".into(), or_value("role", string("житель этих мест")));
                entry.insert("location".into(), or_value("location", scene_field("location")));
                if js::truthy(field("locationId")) {
                    entry.insert("location_id".into(), field("locationId").cloned().unwrap_or(Value::Null));
                }
                entry.insert("public_summary".into(), or_value("summary", string(format!("{} — часть первой сцены.", js::string(field("name"))))));
                entry.insert("voice".into(), or_value("voice", string("Говорит спокойно и по делу.")));
                if js::truthy(field("speechProfile")) {
                    entry.insert("speech_profile".into(), field("speechProfile").cloned().unwrap_or(Value::Null));
                }
                let non_empty = |key: &str, fallback: &str| if list(field(key)).is_empty() { json!([fallback]) } else { field(key).cloned().unwrap_or(Value::Null) };
                entry.insert("goals".into(), non_empty("goals", "Пережить происходящее"));
                entry.insert("beliefs".into(), non_empty("beliefs", "Слухам верить нельзя"));
                if js::truthy(field("socialDcs")) {
                    entry.insert("social_dcs".into(), field("socialDcs").cloned().unwrap_or(Value::Null));
                }
                if !list(field("inventory")).is_empty() {
                    entry.insert("inventory".into(), field("inventory").cloned().unwrap_or(Value::Null));
                }
                entry.insert("known_fact_ids".into(), json!([]));
                entry.insert("visibility".into(), or_value("visibility", string("party")));
                if js::is_true(field("revealOnPresence")) {
                    entry.insert("reveal_on_presence".into(), Value::Bool(true));
                }
                entry.insert("available".into(), Value::Bool(!night_visitors.contains(&js::s(field("id")))));
                let faction = match field("factionId") {
                    Some(Value::String(id)) => faction_ids.get(id).map(|id| string(id.clone())),
                    _ => None,
                }
                .unwrap_or_else(|| starter_faction_id.clone());
                let mut tags: Vec<Value> = Vec::new();
                for tag in list(field("tags")).iter().cloned().chain(std::iter::once(string(format!("faction:{}", js::string(Some(&faction)))))) {
                    if !tags.contains(&tag) {
                        tags.push(tag);
                    }
                }
                entry.insert("tags".into(), Value::Array(tags));
                entry
            })
            .collect();
        let world_rules = opening.get("worldRules");
        let office_configurations: Option<Vec<Value>> = match prop(world_rules, "offices") {
            Some(Value::Array(offices)) => Some(
                offices
                    .iter()
                    .map(|office| {
                        let mut copy = office.as_object().cloned().unwrap_or_default();
                        let own = office.get("faction_id");
                        let mapped = match own {
                            Some(Value::String(id)) => faction_ids.get(id).map(|id| string(id.clone())),
                            _ => None,
                        };
                        match mapped.or_else(|| nullish(own, None).cloned()) {
                            Some(value) => {
                                copy.insert("faction_id".into(), value);
                            }
                            None => {
                                if own.is_some() {
                                    copy.insert("faction_id".into(), Value::Null);
                                }
                            }
                        }
                        Value::Object(copy)
                    })
                    .collect(),
            ),
            _ => None,
        };
        let world_offices = office_configurations.map(|offices| {
            normalize_world_offices_state(
                Some(&json!({ "schema_version": 1, "offices": offices })),
                &json!({
                    "knownNpcIds": opening_npcs.iter().map(|npc| npc.get("id").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(),
                    "knownFactionIds": faction_entities.iter().map(|faction| faction.get("id").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(),
                }),
            )
        });
        let offices = list(prop(world_offices.as_ref(), "offices")).to_vec();
        let office_by_id = |id: Option<&Value>| id.and_then(|id| offices.iter().rev().find(|office| office.get("id") == Some(id)));
        let starter_responsibility = prop(world_rules, "starter_responsibility").filter(|value| js::truthy(Some(value))).cloned();
        let offered_quests: Vec<Value> = match prop(world_rules, "offered_quests") {
            Some(Value::Array(quests)) => quests
                .iter()
                .map(|quest| {
                    let field = |key: &str| prop(Some(quest), key);
                    let office = office_by_id(prop(field("responsibility"), "office_id"));
                    let mut entry = Map::new();
                    if let Some(id) = field("id") {
                        entry.insert("id".into(), id.clone());
                    }
                    if let Some(title) = field("title") {
                        entry.insert("title".into(), title.clone());
                    }
                    if let Some(summary) = if js::truthy(field("summary")) { field("summary") } else { field("title") } {
                        entry.insert("summary".into(), summary.clone());
                    }
                    entry.insert("status".into(), string("offered"));
                    entry.insert("visibility".into(), if js::truthy(field("visibility")) { field("visibility").cloned().unwrap_or(Value::Null) } else { string("party") });
                    let office_faction = prop(office, "faction_id");
                    entry.insert("entity_ids".into(), if js::truthy(office_faction) { json!([office_faction]) } else { json!([]) });
                    entry.insert("objectives".into(), match field("objectives") { Some(Value::Array(items)) => Value::Array(items.clone()), _ => json!([]) });
                    if let Some(responsibility) = field("responsibility") {
                        entry.insert("responsibility".into(), responsibility.clone());
                    }
                    let giver = if js::truthy(field("giver_npc_id")) {
                        field("giver_npc_id").cloned()
                    } else if js::truthy(prop(office, "holder_npc_id")) {
                        prop(office, "holder_npc_id").cloned()
                    } else {
                        None
                    };
                    entry.insert("giver_npc_id".into(), giver.unwrap_or(Value::Null));
                    Value::Object(entry)
                })
                .collect(),
            _ => Vec::new(),
        };
        // Жители первой сцены стоят на поле сразу — тот же планировщик, что у переходов.
        let starting_location_id = if js::truthy(Some(&current_location_id)) { current_location_id.clone() } else { scene_field("location") };
        let mut theme_request = Map::new();
        for (key, value) in [("location", scene.get("location")), ("theme", scene.get("theme"))] {
            if let Some(value) = value {
                theme_request.insert(key.into(), value.clone());
            }
        }
        theme_request.insert("worldKind".into(), string(starting_world_kind));
        if let Some(map) = scene.get("map") {
            theme_request.insert("request".into(), map.clone());
        }
        let starting_theme = resolve_scene_theme(&Value::Object(theme_request));
        let starting_theme_id = starting_theme.asset_theme().unwrap_or(starting_theme.id);
        if is_live_theme(Some(starting_theme)) && ["building", "temple", "crypt", "cave", "forest", "road", "settlement"].contains(&starting_theme_id) {
            geometry.map.theme = starting_theme_id.to_string();
        }
        let scene_tactical_map = serialize_tactical_map(&geometry.map)?;
        let library_extras = geometry.library.as_ref().map(library_scene_fields).unwrap_or_default();
        let mut library_memory = json!({});
        if let Some(library) = &geometry.library {
            for level in &library.levels {
                let key = level_key_js(Some(&starting_location_id), Some(&num(level.index)));
                let cells = legacy_cells_from_tactical_map(&deserialize_tactical_map(&level.map)?);
                remember_scene_map(&mut library_memory, Some(&string(key)), Some(&Value::Array(cells)), Some(&level.map));
            }
        }
        // Вещи, которые сценарий с начала кампании отдаёт в руки своим NPC.
        let mut scenario_inventories = Map::new();
        if let Value::Object(by_npc) = scenario_knight_starting_inventory(scenario) {
            for (npc_id, catalog_ids) in js::entries(&by_npc) {
                let items: Vec<Value> = list(Some(catalog_ids))
                    .iter()
                    .enumerate()
                    .map(|(index, catalog_id)| {
                        let item = materialize_catalog_item(&js::string(Some(catalog_id)), Some(&json!({ "quantity": 1, "origin": "gifted" })));
                        let fallback_id = format!("scenario-start:{npc_id}:{}", index + 1);
                        let mut normalized = normalize_inventory_item(Some(&item), InventoryItemOptions { id_fallback: &fallback_id, preserve_unknown: true, hydrate_catalog: false });
                        if let Value::Object(map) = &mut normalized {
                            map.insert("origin".into(), string("gifted"));
                        }
                        normalized
                    })
                    .collect();
                scenario_inventories.insert(npc_id.clone(), Value::Array(items));
            }
        }
        let mut profiles = Map::new();
        for (index, npc) in npcs.iter().filter(|npc| js::truthy(prop(Some(npc), "mechanics"))).enumerate() {
            let id = if js::truthy(prop(Some(npc), "id")) { js::string(prop(Some(npc), "id")) } else { format!("npc-{seed12}-{}", index + 1) };
            profiles.insert(id, prop(Some(npc), "mechanics").cloned().unwrap_or(Value::Null));
        }
        let empty_npc_world = json!({
            "schema_version": 3,
            "placements": [], "vitals": {}, "stances": {}, "inventories": Value::Object(scenario_inventories),
            "profiles": Value::Object(profiles),
        });
        let scene_state = {
            let mut state = Map::new();
            state.insert("title".into(), scene_field("title"));
            state.insert("location".into(), scene_field("location"));
            state.insert("location_id".into(), starting_location_id.clone());
            state.insert("mood".into(), scene_field("mood"));
            state.insert("objective".into(), scene_field("objective"));
            state.insert("turn".into(), json!(1));
            if let Some(levels) = geometry.levels.as_ref().filter(|levels| !levels.is_empty()) {
                state.insert("levels".into(), Value::Array(levels.iter().map(|level| level.to_json()).collect()));
            }
            for (key, value) in library_extras {
                state.insert(key, value);
            }
            if let Some(program) = &map_requirements {
                let mut requirements = program.as_object().cloned().unwrap_or_default();
                if let Some(missing) = geometry.missing.as_ref().filter(|missing| !missing.is_empty()) {
                    requirements.insert("missing".into(), json!(missing));
                }
                state.insert("map_requirements".into(), Value::Object(requirements));
            }
            state.insert("cells".into(), Value::Array(cells.clone()));
            state.insert("map".into(), scene_tactical_map);
            Value::Object(state)
        };
        let placement_draft = json!({
            "scene": scene_state,
            "social": { "npcs": opening_npcs.iter().cloned().map(Value::Object).collect::<Vec<_>>() },
            "players": positioned_heroes,
            "npc_world": empty_npc_world,
            "mechanics": start_mechanics,
        });
        let mut npc_world = empty_npc_world.clone();
        for (index, draft) in plan_scene_npc_placement_events(&placement_draft).into_iter().enumerate() {
            let mut event = draft.as_object().cloned().unwrap_or_default();
            event.insert("event_id".into(), string(format!("bootstrap-npc-{seed}-{}", index + 1)));
            npc_world = apply_npc_world_event(Some(&npc_world), &Value::Object(event), &json!({}));
        }
        let hook = opening.get("hook").cloned().unwrap_or(Value::Null);
        let adventure = json!({
            "chapter": 1, "currentHook": hook,
            "visitedLocations": [scene_field("location")], "unresolvedThreads": [hook], "history": [],
        });
        let scene_memory = ensure_scene_world_memory(
            Some(&json!({})),
            &json!({
                "scene": { "title": scene_field("title"), "location": scene_field("location"), "mood": scene_field("mood"), "objective": scene_field("objective") },
                "campaignConcept": concept_value,
                "adventure": adventure,
            }),
        )?;
        let wanted_location = lower(&scene_location);
        let location_entity = list(scene_memory.get("entities"))
            .iter()
            .find(|entity| entity.get("kind").and_then(Value::as_str) == Some("location") && lower(&js::s(entity.get("name"))) == wanted_location)
            .cloned();
        let mut opening_facts = opening_narration_facts(&opening, location_entity.as_ref(), &campaign_code, &start_minutes);
        opening_facts.extend(opening_canon_facts(&opening, location_entity.as_ref(), &campaign_code, &start_minutes));
        let opening_fact_ids: Vec<Value> = opening_facts.iter().map(|fact| fact.get("id").cloned().unwrap_or(Value::Null)).collect();
        // Знание пролога — у жителей текущей сцены.
        for npc in &mut opening_npcs {
            let same_location = !js::truthy(npc.get("location_id"))
                || npc.get("location_id") == Some(&starting_location_id)
                || npc.get("location").and_then(Value::as_str).is_some_and(|location| lower(location) == wanted_location);
            if same_location {
                npc.insert("known_fact_ids".into(), Value::Array(opening_fact_ids.clone()));
            }
        }
        let secret_facts = opening_secret_facts(&opening, location_entity.as_ref(), &campaign_code);
        // Тайны сценария стартового места пишутся сразу.
        let scenario_start_secrets: Vec<Value> = match &location_entity {
            Some(entity) => scenario_secrets_for(&json!({ "campaignConcept": concept_value }), &js::s(Some(&starting_location_id)))
                .iter()
                .map(|secret| {
                    let fact = gm_secret_fact(
                        &json!({ "clue": secret.get("clue"), "topic": secret.get("topic"), "skills": secret.get("skills"), "holder": "" }),
                        &json!({ "subjectId": entity.get("id"), "salt": secret.get("fact_id"), "index": 0, "sourceCommandId": format!("bootstrap:{campaign_code}") }),
                    );
                    let mut fact = fact.as_object().cloned().unwrap_or_default();
                    fact.insert("id".into(), secret.get("fact_id").cloned().unwrap_or(Value::Null));
                    Value::Object(fact)
                })
                .collect(),
            None => Vec::new(),
        };
        // Секрет знает только названный хранитель.
        let opening_secrets = list(opening.get("secrets"));
        for (index, fact) in secret_facts.iter().enumerate() {
            let holder = lower(&clean(prop(opening_secrets.get(index), "holder"), 120));
            if holder.is_empty() {
                continue;
            }
            if let Some(npc) = opening_npcs.iter_mut().find(|entry| lower(&clean(entry.get("name"), 120)) == holder) {
                let mut known = list(npc.get("known_fact_ids")).to_vec();
                known.push(fact.get("id").cloned().unwrap_or(Value::Null));
                npc.insert("known_fact_ids".into(), Value::Array(known));
            }
        }
        // Хранители тайн сценария знают свою часть истории.
        for npc in &mut opening_npcs {
            let known = scenario_clue_fact_ids_known_by(scenario, &js::s(npc.get("id")));
            if !known.is_empty() {
                let mut ids: Vec<Value> = Vec::new();
                for id in list(npc.get("known_fact_ids")).iter().cloned().chain(known.into_iter().map(Value::String)) {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
                npc.insert("known_fact_ids".into(), Value::Array(ids));
            }
        }
        let starter_title = starter_quest_title(&opening);
        let mut initial_memory = scene_memory.as_object().cloned().unwrap_or_default();
        let mut facts = list(scene_memory.get("facts")).to_vec();
        facts.extend(opening_facts);
        facts.extend(secret_facts);
        facts.extend(scenario_start_secrets);
        initial_memory.insert("facts".into(), Value::Array(facts));
        let mut entities = list(scene_memory.get("entities")).to_vec();
        entities.extend(faction_entities.iter().cloned());
        initial_memory.insert("entities".into(), Value::Array(entities));
        let mut quests = list(scene_memory.get("quests")).to_vec();
        let mut starter = Map::new();
        starter.insert("id".into(), string(starter_quest_id));
        starter.insert("title".into(), string(starter_title.clone()));
        let hook_differs = js::truthy(Some(&hook)) && hook != string(starter_title);
        starter.insert("summary".into(), if hook_differs { hook.clone() } else { scene_field("objective") });
        starter.insert("status".into(), string("active"));
        starter.insert("visibility".into(), string("party"));
        starter.insert("entity_ids".into(), json!([starter_faction_id]));
        starter.insert("objectives".into(), json!([scene_field("objective")]));
        let clock_max = nullish(prop(arc.as_ref(), "target_scenes"), None).cloned().unwrap_or_else(|| json!(4));
        starter.insert("clock".into(), json!({ "current": 0, "max": clock_max, "label": "Прогресс расследования" }));
        if let Some(responsibility) = &starter_responsibility {
            starter.insert("responsibility".into(), responsibility.clone());
            starter.insert("giver_npc_id".into(), nullish(responsibility.get("npc_id"), None).cloned().unwrap_or(Value::Null));
        }
        quests.push(Value::Object(starter));
        quests.extend(offered_quests);
        initial_memory.insert("quests".into(), Value::Array(quests));
        let social_npcs: Vec<Value> = opening_npcs.iter().cloned().map(Value::Object).collect();
        let relationships: Map<String, Value> = opening_npcs
            .iter()
            .map(|npc| {
                let row: Map<String, Value> = positioned_heroes.iter().map(|hero| (js::string(hero.get("id")), json!(0))).collect();
                (js::string(npc.get("id")), Value::Object(row))
            })
            .collect();
        let first_hero_id = positioned_heroes.first().and_then(|hero| hero.get("id")).cloned().unwrap_or(Value::Null);
        let mut house_rules: Vec<Value> = Vec::new();
        for rule in list(selected_ruleset.get("enabled_house_rules")).iter().cloned().chain((!merchants.is_empty()).then(|| string(ECONOMY_POLICY_ID))) {
            if !house_rules.contains(&rule) {
                house_rules.push(rule);
            }
        }
        let now = clock::now_ms();
        let mut state = Map::new();
        state.insert("sessionCode".into(), string(campaign_code.clone()));
        state.insert("character_start_level".into(), json!(start_level));
        state.insert("campaign".into(), display_name);
        state.insert("partyName".into(), if group_name == "Новый отряд" { opening.get("partyName").cloned().unwrap_or(Value::Null) } else { string(group_name) });
        state.insert("partyMemberIds".into(), Value::Array(positioned_heroes.iter().map(|hero| hero.get("id").cloned().unwrap_or(Value::Null)).collect()));
        state.insert("partyDecisionPolicy".into(), DEFAULT_PARTY_DECISION_POLICY.clone());
        state.insert("campaignConcept".into(), concept_value);
        state.insert("worldMap".into(), campaign_world_map);
        state.insert("worldMemory".into(), Value::Object(initial_memory));
        state.insert("social".into(), json!({ "npcs": social_npcs, "relationships": relationships, "conversations": [], "promises": [] }));
        state.insert("state_version".into(), json!(0));
        if let Value::Object(ruleset) = &selected_ruleset {
            for (key, value) in ruleset {
                state.insert(key.clone(), value.clone());
            }
        }
        state.insert("enabled_house_rules".into(), Value::Array(house_rules));
        state.insert("ruleset_locked_at".into(), string(clock::iso(now)));
        state.insert("engine_mode".into(), string("enforce"));
        state.insert("players".into(), Value::Array(positioned_heroes.clone()));
        state.insert("merchants".into(), Value::Array(merchants));
        if let Some(offices) = world_offices {
            state.insert("world_offices".into(), offices);
        }
        for key in ["enemies", "entities", "mapFeedback", "battleLog"] {
            state.insert(key.into(), json!([]));
        }
        state.insert("mechanics".into(), start_mechanics);
        state.insert("rulings".into(), json!([]));
        state.insert("activePlayerId".into(), first_hero_id.clone());
        state.insert("tacticalTurn".into(), json!({ "sceneTurn": 1, "actorId": first_hero_id, "movementSpent": 0, "actionUsed": false }));
        state.insert("isNarrating".into(), Value::Bool(false));
        for key in ["pendingCheck", "agentInteraction", "lastDiceRoll"] {
            state.insert(key.into(), Value::Null);
        }
        state.insert("scene".into(), placement_draft.get("scene").cloned().unwrap_or(Value::Null));
        state.insert("npc_world".into(), npc_world);
        if let Some(maps) = library_memory.get("locationMaps") {
            state.insert("locationMaps".into(), maps.clone());
        }
        state.insert("adventure".into(), adventure);
        state.insert(
            "messages".into(),
            json!([{
                "id": format!("opening-{seed}"), "speaker": "narrator", "author": "Рассказчик",
                "timestamp": clock_label(now), "text": opening.get("openingNarration"), "turnConsumed": false,
            }]),
        );
        Ok(Value::Object(state))
    }
}

/// `new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' })
/// .format(new Date())` в часовом поясе боевого сервера (Docker — UTC).
fn clock_label(now_ms: i64) -> String {
    let minutes = now_ms.div_euclid(60_000).rem_euclid(24 * 60);
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

/// Вход второй половины `create` — всё, что известно после модели.
struct Finish {
    campaign_code: String,
    campaign_name: String,
    group_name: String,
    mode: String,
    start_level: i64,
    selected_ruleset: Value,
    heroes: Vec<Value>,
    world: Map<String, Value>,
    world_template: Option<Value>,
    opening: Value,
    generated_by: &'static str,
    seed: String,
    seed12: String,
    start_minutes: Value,
    start_mechanics: Value,
    merchants: Option<Value>,
}

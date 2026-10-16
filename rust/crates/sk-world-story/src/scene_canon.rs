//! Перенос `server/scene-canon.mjs`: физический канон сцены — одна серверная
//! сводка того, **что сейчас вокруг** отряда: час и время суток, погода, свет,
//! крыша над головой, сырость поверхностей, материалы, вид места и кто виден.
//!
//! Канон выводится, а не хранится: час и погода — из `sk_world_time::weather`
//! (`world_clock_for_agents`), материалы и вода — из открытых клеток
//! тактической карты, вид места — из карты мира. Канон — для глаз игрока: в
//! нём только открытые клетки и NPC без пометок `gm_only` / `npc_private`.
//!
//! Проверка противоречий ([`scene_canon_contradictions`]) — узкая и
//! консервативная: прямые утверждения о текущем часе, небе и сухости, без речи
//! в кавычках, сравнений, отрицаний и фраз о другом времени.
//!
//! Индексы совпадений в JS — единицы UTF-16; здесь окна «до» и «после»
//! совпадения режутся теми же единицами (`support::head_utf16`, [`tail_utf16`]).

mod patterns;

use std::sync::LazyLock;

use fancy_regex::Regex;
use serde_json::{json, Map, Value};
use sk_core::{js, text as jstext};
use sk_geometry::world_map::world_location_by_id;
use sk_npc_world::npc_positioning::present_scene_npcs;
use sk_tactical::tactical_map::{cell_at, deserialize_tactical_map};
use sk_world_time::weather::{
    campaign_day_of, clock_label_of, day_phase_label, time_of_day_of, weather_condition_label, weather_condition_summary, weather_on_day,
    world_clock_for_agents, BIOME_WEATHER_WEIGHTS, CAMPAIGN_START_MINUTE_OF_DAY, DAY_PHASES, WEATHER_CONDITION_IDS,
};

use crate::support::{array, head_utf16, is_str, object_prototype_member, path, prop, ProtoMember};
use patterns::*;

pub const SCENE_CANON_VERSION: &str = "scene-canon/v1";
pub const SCENE_CANON_CONTRADICTION: &str = "SCENE_CANON_CONTRADICTION";

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, max)`.
fn text(value: Option<&Value>, max: usize) -> String {
    head_utf16(&jstext::squash_spaces(&jstext::nfkc(&js::s(value))), max)
}

/// `a || b || c` над JSON: первое истинное значение, иначе последнее.
fn or_chain<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|value| js::truthy(*value)).unwrap_or_else(|| values.last().copied().flatten())
}

/// `a ?? b`.
fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if js::present(a) {
        a
    } else {
        b
    }
}

fn compile(source: &str, flags: &str) -> Regex {
    // Источники — константы модуля, снятые с JS; ошибка сборки — ошибка переноса.
    jstext::js_regex(source, flags).unwrap_or_else(|| panic!("регулярное выражение канона: {source}"))
}

fn compile_all<const N: usize>(sources: [&str; N], flags: &str) -> Vec<Regex> {
    sources.iter().map(|source| compile(source, flags)).collect()
}

fn single(pattern: (&str, &str)) -> Regex {
    compile(pattern.0, pattern.1)
}

/// Пары `(ключ, выражение)` с одними флагами.
fn keyed<const N: usize>(pairs: [(&'static str, &str); N], flags: &str) -> Vec<(&'static str, Regex)> {
    pairs.iter().map(|(key, source)| (*key, compile(source, flags))).collect()
}

static WATER_PLACE: LazyLock<Regex> = LazyLock::new(|| single(WATER_PLACE_PATTERN));
static PHASE_WORDS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| keyed(OPENING_PHASE_WORDS, "gu"));
static WEATHER_WORDS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| keyed(OPENING_WEATHER_WORDS, "gu"));
static SHIFT_PREFIX: LazyLock<Regex> = LazyLock::new(|| single(OPENING_SHIFT_PREFIX));
static WEATHER_SHIFT_PREFIX: LazyLock<Regex> = LazyLock::new(|| single(OPENING_WEATHER_SHIFT_PREFIX));
static OPENING_SHIFTED: LazyLock<Regex> = LazyLock::new(|| single(OPENING_SHIFTED_SENTENCE));
static NIGHT: LazyLock<Vec<Regex>> = LazyLock::new(|| compile_all(NIGHT_PATTERNS, "giu"));
static DARKENING: LazyLock<Vec<Regex>> = LazyLock::new(|| compile_all(DARKENING_PATTERNS, "giu"));
static DAY: LazyLock<Vec<Regex>> = LazyLock::new(|| compile_all(DAY_PATTERNS, "giu"));
static MORNING: LazyLock<Vec<Regex>> = LazyLock::new(|| compile_all(MORNING_PATTERNS, "giu"));
static EVENING: LazyLock<Vec<Regex>> = LazyLock::new(|| compile_all(EVENING_PATTERNS, "giu"));
static RAIN: LazyLock<Vec<Regex>> = LazyLock::new(|| compile_all(RAIN_PATTERNS, "giu"));
static HEAVY_RAIN: LazyLock<Vec<Regex>> = LazyLock::new(|| compile_all(HEAVY_RAIN_PATTERNS, "giu"));
static STORM: LazyLock<Vec<Regex>> = LazyLock::new(|| compile_all(STORM_PATTERNS, "giu"));
static FOG: LazyLock<Vec<Regex>> = LazyLock::new(|| compile_all(FOG_PATTERNS, "giu"));
static CLEAR_SKY: LazyLock<Vec<Regex>> = LazyLock::new(|| compile_all(CLEAR_SKY_PATTERNS, "giu"));
static DRY: LazyLock<Vec<Regex>> = LazyLock::new(|| compile_all(DRY_PATTERNS, "giu"));
static SKY_INDOOR: LazyLock<Vec<Regex>> = LazyLock::new(|| compile_all(SKY_INDOOR_PATTERNS, "giu"));
static SHIFTED: LazyLock<Regex> = LazyLock::new(|| single(SHIFTED_SENTENCE));
static NEGATED: LazyLock<Regex> = LazyLock::new(|| single(NEGATED_PREFIX));
static SHIFTED_TIME: LazyLock<Regex> = LazyLock::new(|| single(SHIFTED_TIME_PREFIX));
static SHIFTED_WEATHER: LazyLock<Regex> = LazyLock::new(|| single(SHIFTED_WEATHER_PREFIX));
static ENDING: LazyLock<Regex> = LazyLock::new(|| single(ENDING_SUFFIX));
static MIND: LazyLock<Regex> = LazyLock::new(|| single(MIND_CONTEXT));
static NEGATED_AFTER: LazyLock<Regex> = LazyLock::new(|| single(NEGATED_SUFFIX));
static TIME_ADJECTIVE: LazyLock<Regex> = LazyLock::new(|| single(WEATHER_TIME_ADJECTIVE));
static FAR_WEATHER: LazyLock<Regex> = LazyLock::new(|| single(FAR_WEATHER_CONTEXT));
static ENCLOSED_DRY: LazyLock<Regex> = LazyLock::new(|| single(ENCLOSED_DRY_CONTEXT));
static OPENING: LazyLock<Regex> = LazyLock::new(|| single(OPENING_CONTEXT));
static SKIPS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| keyed(EVENT_SKIPS, "iu"));
static TOPIC_SKIPS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| keyed(EVENT_TOPIC_SKIPS, "iu"));
static INDOOR_ONLY: LazyLock<Regex> = LazyLock::new(|| single(INDOOR_ONLY_ANCHOR));
static DRY_WORD: LazyLock<Regex> = LazyLock::new(|| single(DRY_ANCHOR));

fn skip_for<'a>(table: &'a [(&'static str, Regex)], key: &str) -> Option<&'a Regex> {
    table.iter().find(|(id, _)| *id == key).map(|(_, regex)| regex)
}

const LOCATION_KIND_LABELS: [(&str, &str); 10] = [
    ("capital", "столица"), ("city", "город"), ("town", "городок"), ("village", "деревня"), ("port", "порт"),
    ("fortress", "крепость"), ("ruin", "руины"), ("dungeon", "подземелье"), ("landmark", "примечательное место"), ("wilds", "дикие земли"),
];

const MATERIAL_LABELS: [(&str, &str); 8] = [
    ("stone", "камень"), ("wood", "дерево"), ("earth", "земля"), ("grass", "трава"), ("sand", "песок"), ("marble", "мрамор"), ("metal", "металл"), ("ice", "лёд"),
];

const HIDDEN_VISIBILITY: [&str; 4] = ["gm_only", "gmonly", "npc_private", "npcprivate"];

/// Чьими глазами смотрит канон (`viewerOf`).
struct Viewer {
    player_id: String,
    actor_id: String,
}

fn viewer_of(viewer: Option<&Value>) -> Viewer {
    let field = |key: &str| prop(viewer, key);
    let player = nullish(field("playerId"), nullish(field("player_id"), nullish(field("viewerId"), field("userId"))));
    let actor = nullish(field("actorId"), nullish(field("actor_id"), nullish(field("heroId"), nullish(field("playerId"), field("player_id")))));
    Viewer { player_id: text(player, 120), actor_id: text(actor, 120) }
}

/// Видна ли запись игроку. Канон не раскрывает закрытого даже ведущему.
fn record_visible_to(record: &Value, viewer: &Viewer) -> bool {
    if !(record.is_object() || record.is_array()) {
        return false;
    }
    let field = |key: &str| prop(Some(record), key);
    if js::is_true(field("hidden")) || js::is_true(field("secret")) {
        return false;
    }
    let public = Value::String("public".into());
    let visibility = text(nullish(field("visibility"), nullish(field("visibility_level"), Some(&public))), 40).to_lowercase();
    if HIDDEN_VISIBILITY.contains(&visibility.as_str()) {
        return js::is_true(field("reveal_on_presence"));
    }
    if visibility == "specific_player" {
        let mut allowed: Vec<Option<&Value>> = vec![field("player_id"), field("playerId"), field("owner_id")];
        allowed.extend(array(field("visible_to")).iter().map(Some));
        let allowed: Vec<String> = allowed.into_iter().map(|id| text(id, 120)).collect();
        return !viewer.player_id.is_empty() && allowed.contains(&viewer.player_id);
    }
    true
}

/// Материалы и вода по **открытым** клеткам карты.
struct SurfaceFacts {
    materials: Vec<String>,
    water: bool,
}

fn map_surface_facts(raw_map: Option<&Value>) -> SurfaceFacts {
    let empty = SurfaceFacts { materials: Vec::new(), water: false };
    let Some(raw) = raw_map.filter(|raw| raw.is_object() || raw.is_array()) else {
        return empty;
    };
    if !js::truthy(prop(Some(raw), "layers")) {
        return empty;
    }
    let Ok(map) = deserialize_tactical_map(raw) else {
        return empty;
    };
    let mut counts: Vec<(&'static str, f64)> = Vec::new();
    let mut revealed = 0.0;
    let mut water = 0.0;
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(cell) = cell_at(&map, x, y) else { continue };
            if !cell.revealed {
                continue;
            }
            revealed += 1.0;
            match counts.iter_mut().find(|(material, _)| *material == cell.material) {
                Some(entry) => entry.1 += 1.0,
                None => counts.push((cell.material, 1.0)),
            }
            if cell.surface == "water" {
                water += 1.0;
            }
        }
    }
    if revealed == 0.0 {
        return empty;
    }
    let mut kept: Vec<(&'static str, f64)> = counts.into_iter().filter(|(_, count)| count / revealed >= 0.1).collect();
    kept.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| jstext::locale_compare(left.0, right.0)));
    let materials = kept
        .iter()
        .take(3)
        .filter_map(|(material, _)| MATERIAL_LABELS.iter().find(|(id, _)| id == material).map(|(_, label)| label.to_string()))
        .collect();
    SurfaceFacts { materials, water: water / revealed >= 0.02 || water >= 6.0 }
}

fn light_for(indoors: bool, phase: &str, weather: &str) -> (&'static str, &'static str) {
    if indoors {
        return match phase {
            "night" => ("interior_dark", "под крышей; светят только очаг, лампы и свечи"),
            "evening" => ("interior_dim", "под крышей; за окнами сумерки, светят очаг и лампы"),
            _ => ("interior", "под крышей; дневной свет лишь из окон и проёмов"),
        };
    }
    let covered = weather == "rain" || weather == "storm";
    if phase == "night" {
        return match weather {
            "clear" => ("dark", "ночная темнота; светят луна и звёзды"),
            "fog" => ("dark", "кромешная темнота; туман глушит редкие огни"),
            _ => ("dark", "кромешная темнота; луну и звёзды скрывает небо"),
        };
    }
    if phase == "evening" {
        return if covered || weather == "fog" { ("dusk", "ранние сумерки под тяжёлым небом") } else { ("dusk", "вечерние сумерки, длинные тени") };
    }
    if weather == "fog" {
        return ("dim", "рассеянный серый свет; туман скрадывает всё дальше десятка шагов");
    }
    if covered {
        return ("dim", "серый сумрак под тучами");
    }
    if weather == "overcast" {
        return ("daylight", if phase == "morning" { "ровный серый утренний свет" } else { "ровный серый свет без резких теней" });
    }
    ("daylight", if phase == "morning" { "утренний свет, низкое солнце" } else { "яркий дневной свет" })
}

fn wetness_for(indoors: bool, weather: &str, water_nearby: bool) -> (&'static str, &'static str) {
    if indoors {
        return ("sheltered", "под крышей сухо");
    }
    if weather == "rain" || weather == "storm" {
        return ("wet", "мокро: дождь мочит землю, дерево и камень");
    }
    if weather == "fog" {
        return ("damp", "сыро: туман оседает влагой на дереве, камне и одежде");
    }
    if water_nearby {
        return ("dry", "сухо, но у кромки воды доски и камни влажные");
    }
    ("dry", "сухо")
}

/// Подпись вида места: `LOCATION_KIND_LABELS[kind] ?? ''` — с ключами прототипа.
enum KindLabel {
    Text(&'static str),
    Proto(ProtoMember),
}

impl KindLabel {
    fn of(kind: &str) -> Self {
        if let Some((_, label)) = LOCATION_KIND_LABELS.iter().find(|(id, _)| *id == kind) {
            return Self::Text(label);
        }
        object_prototype_member(kind).map_or(Self::Text(""), Self::Proto)
    }

    fn truthy(&self) -> bool {
        !matches!(self, Self::Text(""))
    }

    /// Шаблон JS: `${label}`.
    fn display(&self) -> String {
        match self {
            Self::Text(label) => (*label).to_string(),
            Self::Proto(member) => member.display(),
        }
    }

    /// `kind_label` в JSON: функция пропадает, прототип — `{}`.
    fn insert_into(&self, map: &mut Map<String, Value>) {
        match self {
            Self::Text(label) => {
                map.insert("kind_label".into(), json!(label));
            }
            Self::Proto(member) => {
                if let Some(value) = member.json() {
                    map.insert("kind_label".into(), value);
                }
            }
        }
    }
}

/// Вход `assembleCanon`.
struct CanonParts {
    time: Map<String, Value>,
    weather_id: String,
    indoors: bool,
    location_name: String,
    location_kind: String,
    kind_label: KindLabel,
    region: String,
    biome: String,
    water_nearby: bool,
    materials: Vec<String>,
    heroes: Vec<String>,
    npcs: Vec<String>,
    creatures: Vec<String>,
}

fn time_str<'a>(time: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    time.get(key)
}

fn canon_summary(parts: &CanonParts, light_label: &str, surfaces_label: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let phase_label = time_str(&parts.time, "phase_label");
    let clock = time_str(&parts.time, "clock");
    if js::truthy(phase_label) {
        let clock_part = if js::truthy(clock) { format!(", {}", js::s(clock)) } else { String::new() };
        out.push(format!("{}{clock_part}.", js::s(phase_label)));
    }
    let label = weather_condition_label(&parts.weather_id);
    let summary = weather_condition_summary(&parts.weather_id);
    if !label.is_empty() {
        let tail = if summary.is_empty() { ".".to_string() } else { format!(" — {}", jstext::lower(summary)) };
        out.push(format!("Погода: {}{tail}", jstext::lower(label)));
    }
    out.push(if parts.indoors { "Под крышей.".into() } else { "Под открытым небом.".into() });
    if !light_label.is_empty() {
        out.push(format!("Свет: {light_label}."));
    }
    if !surfaces_label.is_empty() {
        out.push(format!("Поверхности: {surfaces_label}."));
    }
    if parts.water_nearby {
        out.push("Рядом вода.".into());
    }
    if !parts.materials.is_empty() {
        out.push(format!("Материалы вокруг: {}.", parts.materials.join(", ")));
    }
    if !parts.location_name.is_empty() {
        let kind = if parts.kind_label.truthy() { format!("; на карте мира — {}", parts.kind_label.display()) } else { String::new() };
        out.push(format!("Место: «{}»{kind}.", parts.location_name));
    }
    let present: Vec<&String> = parts.heroes.iter().chain(parts.npcs.iter()).collect();
    if !present.is_empty() {
        out.push(format!("На виду: {}.", present.iter().map(|name| name.as_str()).collect::<Vec<_>>().join(", ")));
    }
    head_utf16(&out.join(" ").replace("..", "."), 900)
}

fn assemble_canon(parts: CanonParts) -> Value {
    let phase = parts.time.get("phase").and_then(Value::as_str).unwrap_or_default();
    let phase = if is_str(parts.time.get("phase"), phase) { phase } else { "" };
    let (light_level, light_label) = light_for(parts.indoors, phase, &parts.weather_id);
    let (wetness, surfaces_label) = wetness_for(parts.indoors, &parts.weather_id, parts.water_nearby);
    let summary = canon_summary(&parts, light_label, surfaces_label);
    let mut location = Map::new();
    location.insert("name".into(), json!(parts.location_name));
    location.insert("kind".into(), json!(parts.location_kind));
    parts.kind_label.insert_into(&mut location);
    location.insert("region".into(), json!(parts.region));
    location.insert("biome".into(), json!(parts.biome));
    json!({
        "version": SCENE_CANON_VERSION,
        "location": location,
        "time": parts.time,
        "weather": {
            "id": parts.weather_id,
            "label": weather_condition_label(&parts.weather_id),
            "summary": weather_condition_summary(&parts.weather_id),
        },
        "indoors": parts.indoors,
        "light": { "level": light_level, "label": light_label },
        "surfaces": { "wetness": wetness, "label": surfaces_label, "water_nearby": parts.water_nearby, "materials": parts.materials },
        "present": { "heroes": parts.heroes, "npcs": parts.npcs, "creatures": parts.creatures },
        "summary": summary,
    })
}

fn insert_raw(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// Канон сцены для зрителя (`sceneCanonFor(state, viewer)`): крыша считается
/// по клетке его героя. `viewer` — `None` для параметра по умолчанию.
pub fn scene_canon_for(state: &Value, viewer: Option<&Value>) -> Value {
    let who = viewer_of(viewer);
    let actor = Value::String(who.actor_id.clone());
    let clock = world_clock_for_agents(state, if who.actor_id.is_empty() { None } else { Some(&actor) });
    let scene = nullish(prop(Some(state), "scene"), None);
    let world_map = prop(Some(state), "worldMap");
    let node = world_location_by_id(world_map, &text(prop(world_map, "currentLocationId"), 120));
    let region_id = text(prop(node, "regionId"), 120);
    let region = array(prop(world_map, "regions")).iter().find(|entry| text(prop(Some(entry), "id"), 120) == region_id);
    let kind = text(prop(node, "kind"), 40);
    let scene_field = |key: &str| prop(scene, key);
    let name = text(or_chain(&[scene_field("location"), scene_field("title"), prop(node, "name")]), 160);
    let facts = map_surface_facts(scene_field("map"));
    let place_words = [scene_field("location"), scene_field("title"), scene_field("theme"), scene_field("mood"), prop(node, "name")]
        .iter()
        .map(|value| text(*value, 300))
        .collect::<Vec<_>>()
        .join(" ");
    let water_nearby = facts.water || kind == "port" || jstext::test(&WATER_PLACE, &place_words);
    let heroes: Vec<String> = array(prop(Some(state), "players"))
        .iter()
        .filter(|hero| js::truthy(Some(hero)) && !js::is_false(prop(Some(hero), "alive")) && record_visible_to(hero, &who))
        .map(|hero| text(or_chain(&[prop(Some(hero), "character"), prop(Some(hero), "name")]), 80))
        .filter(|name| !name.is_empty())
        .take(8)
        .collect();
    let npcs: Vec<String> = present_scene_npcs(state)
        .iter()
        .filter(|npc| record_visible_to(npc, &who))
        .map(|npc| text(prop(Some(npc), "name"), 80))
        .filter(|name| !name.is_empty())
        .take(8)
        .collect();
    let one = json!(1);
    let creatures: Vec<String> = array(prop(Some(state), "enemies"))
        .iter()
        .filter(|enemy| {
            js::truthy(Some(enemy))
                && !js::is_false(prop(Some(enemy), "alive"))
                && js::number(nullish(prop(Some(enemy), "hp"), Some(&one))) > 0.0
                && record_visible_to(enemy, &who)
        })
        .map(|enemy| text(prop(Some(enemy), "name"), 80))
        .filter(|name| !name.is_empty())
        .take(8)
        .collect();
    let mut time = Map::new();
    insert_raw(&mut time, "day", clock.get("day"));
    insert_raw(&mut time, "clock", clock.get("clock"));
    insert_raw(&mut time, "phase", clock.get("time_of_day"));
    insert_raw(&mut time, "phase_label", clock.get("time_of_day_label"));
    let kind_label = KindLabel::of(&kind);
    assemble_canon(CanonParts {
        time,
        weather_id: js::s(clock.get("weather")),
        indoors: js::truthy(clock.get("indoors")),
        location_name: name,
        location_kind: kind,
        kind_label,
        region: text(prop(region, "name"), 120),
        biome: text(prop(region, "biome"), 40),
        water_nearby,
        materials: facts.materials,
        heroes,
        npcs,
        creatures,
    })
}

/// Канон из уже собранного `known_environment` (`sceneCanonFromEnvironment`).
/// `None` — в окружении нет даже часов.
pub fn scene_canon_from_environment(environment: Option<&Value>) -> Option<Value> {
    let stored = prop(environment, "scene_canon");
    if let Some(stored) = stored.filter(|stored| stored.is_object()) {
        if js::truthy(stored.get("time")) && js::truthy(stored.get("weather")) {
            return Some(stored.clone());
        }
    }
    let clock = prop(environment, "world_clock").filter(|clock| clock.is_object() || clock.is_array())?;
    if !js::truthy(prop(Some(clock), "time_of_day")) {
        return None;
    }
    let clock_field = |key: &str| prop(Some(clock), key);
    let scene = prop(environment, "scene").filter(|scene| !scene.is_null());
    let area_indoors = path(scene, &["spatial_context", "current_area", "indoors"]);
    let indoors = match area_indoors {
        Some(Value::Bool(flag)) => *flag,
        _ => js::truthy(clock_field("indoors")),
    };
    let scene_field = |key: &str| prop(scene, key);
    let place_words =
        [scene_field("location"), scene_field("title"), scene_field("theme"), scene_field("mood")].iter().map(|value| text(*value, 300)).collect::<Vec<_>>().join(" ");
    let story = prop(environment, "story_context").filter(|story| !story.is_null());
    let names = |key: &str| -> Vec<String> {
        array(prop(story, key)).iter().map(|entry| text(prop(Some(entry), "name"), 80)).filter(|name| !name.is_empty()).take(8).collect()
    };
    let mut time = Map::new();
    time.insert("day".into(), nullish(clock_field("day"), None).cloned().unwrap_or(Value::Null));
    time.insert("clock".into(), json!(text(clock_field("clock"), 8)));
    time.insert("phase".into(), json!(text(clock_field("time_of_day"), 20)));
    let label = text(clock_field("time_of_day_label"), 40);
    let label = if label.is_empty() { day_phase_label(&js::string(clock_field("time_of_day"))).to_string() } else { label };
    time.insert("phase_label".into(), json!(label));
    let water_nearby = jstext::test(&WATER_PLACE, &place_words);
    Some(assemble_canon(CanonParts {
        time,
        weather_id: text(clock_field("weather"), 20),
        indoors,
        location_name: text(or_chain(&[scene_field("location"), scene_field("title")]), 160),
        location_kind: String::new(),
        kind_label: KindLabel::Text(""),
        region: String::new(),
        biome: String::new(),
        water_nearby,
        materials: Vec::new(),
        heroes: names("heroes"),
        npcs: names("present_npcs"),
        creatures: Vec::new(),
    }))
}

// ---------------------------------------------------------------------------
// Заказ владельца: час и небо первой сцены

/// Час первой сцены по заказанному времени суток — минута суток мировых часов.
const OPENING_PHASE_CLOCK: [(&str, f64); 5] = [("morning", 480.0), ("day", 780.0), ("evening", 1_140.0), ("night", 1_380.0), ("midnight", 1_440.0)];

/// `text.slice(max(0, at - n), at)` в единицах UTF-16: последние `n` единиц.
pub(crate) fn tail_utf16(source: &str, max: usize) -> String {
    let mut units = 0;
    let mut start = source.len();
    for (index, ch) in source.char_indices().rev() {
        let width = ch.len_utf16();
        if units + width > max {
            break;
        }
        units += width;
        start = index;
    }
    source[start..].to_string()
}

/// `value.split(/(?<=[.!?…])\s+|\n+/u).map(trim).filter(Boolean)`.
fn sentences_of(value: &str) -> Vec<String> {
    let splitter = sk_core::re!(r"(?<=[.!?…])\s+|\n+", "u");
    let mut parts = Vec::new();
    let mut last = 0;
    for found in splitter.find_iter(value).flatten() {
        parts.push(&value[last..found.start()]);
        last = found.end();
    }
    parts.push(&value[last..]);
    parts.into_iter().map(|part| jstext::trim(part).to_string()).filter(|part| !part.is_empty()).collect()
}

/// Кавычки — имена и реплики: таверна «Ночной якорь» ночи не заказывает.
fn without_quotes(value: &str) -> String {
    let value = jstext::replace_all(sk_core::re!(r"«[^»]{0,200}»", "gu"), value, " ");
    let value = jstext::replace_all(sk_core::re!(r"“[^”]{0,200}”", "gu"), &value, " ");
    let value = jstext::replace_all(sk_core::re!(r"„[^“”]{0,200}[“”]", "gu"), &value, " ");
    jstext::replace_all(sk_core::re!(r#""[^"]{0,200}""#, "gu"), &value, " ")
}

/// Первое по тексту слово из словаря, не снятое отрицанием и не о другом времени.
fn first_requested(value: Option<&Value>, words: &[(&'static str, Regex)], weather: bool) -> &'static str {
    let lowered = jstext::lower(&without_quotes(&text(value, 2_000)));
    for sentence in sentences_of(&lowered) {
        if jstext::test(&OPENING_SHIFTED, &sentence) {
            continue;
        }
        let mut best: Option<(&'static str, usize)> = None;
        for (id, pattern) in words {
            for found in pattern.find_iter(&sentence).flatten() {
                let at = found.start();
                let before = tail_utf16(&sentence[..at], 32);
                let after = head_utf16(&sentence[found.end()..], 40);
                let prefix: &Regex = if weather { &WEATHER_SHIFT_PREFIX } else { &SHIFT_PREFIX };
                if jstext::test(prefix, &before) {
                    continue;
                }
                if weather && (jstext::test(&ENDING, &after) || jstext::test(&NEGATED_AFTER, &after) || jstext::test(&MIND, &head_utf16(&after, 12))) {
                    continue;
                }
                if best.is_none_or(|(_, best_at)| at < best_at) {
                    best = Some((id, at));
                }
                break;
            }
        }
        if let Some((id, _)) = best {
            return id;
        }
    }
    ""
}

/// Что владелец заказал словами вводных (`requestedOpeningCanon`):
/// `{ phase, weather }`, пустая строка — не заказано. `world` — объект
/// `{ openingSituation, premise }`; `None` — параметр по умолчанию.
pub fn requested_opening_canon(world: Option<&Value>) -> Value {
    let field = |key: &str| prop(world, key);
    let mut phase = first_requested(field("openingSituation"), &PHASE_WORDS, false);
    if phase.is_empty() {
        phase = first_requested(field("premise"), &PHASE_WORDS, false);
    }
    let mut weather = first_requested(field("openingSituation"), &WEATHER_WORDS, true);
    if weather.is_empty() {
        weather = first_requested(field("premise"), &WEATHER_WORDS, true);
    }
    json!({ "phase": phase, "weather": weather })
}

/// Стартовые часы кампании и небо первого дня (`campaignStartCanon(seed, request)`).
/// `seed` — значение аргумента (`None` — `''`), `request` — `{ phase, weather }`.
pub fn campaign_start_canon(seed: Option<&Value>, request: Option<&Value>) -> Value {
    let phase_key = js::s(prop(request, "phase"));
    let clock_minute = match OPENING_PHASE_CLOCK.iter().find(|(id, _)| *id == phase_key) {
        Some((_, minute)) => *minute,
        // Ключ прототипа находит функцию или прототип: `function - 480` — NaN.
        None if object_prototype_member(&phase_key).is_some() => f64::NAN,
        None => 480.0,
    };
    let elapsed = clock_minute - CAMPAIGN_START_MINUTE_OF_DAY as f64;
    let phase = time_of_day_of(elapsed);
    let day = campaign_day_of(elapsed);
    let time = json!({ "day": day + 1, "clock": clock_label_of(elapsed), "phase": phase, "phase_label": day_phase_label(phase) });
    let requested_weather = js::s(prop(request, "weather"));
    let pinned = if WEATHER_CONDITION_IDS.contains(&requested_weather.as_str()) { requested_weather } else { String::new() };
    let seed_text = text(seed, 120);
    let mut weather_by_biome = Map::new();
    for (biome, _) in BIOME_WEATHER_WEIGHTS {
        let id = if pinned.is_empty() { weather_on_day(&seed_text, day, biome).to_string() } else { pinned.clone() };
        weather_by_biome.insert(
            biome.to_string(),
            json!({ "id": id, "label": weather_condition_label(&id), "summary": weather_condition_summary(&id) }),
        );
    }
    let mut result = Map::new();
    result.insert("time".into(), time);
    result.insert("weather_by_biome".into(), Value::Object(weather_by_biome));
    result.insert("elapsed_minutes".into(), js::num(elapsed));
    if !pinned.is_empty() {
        result.insert("weather_pin".into(), json!({ "day": day, "weather": pinned }));
    }
    Value::Object(result)
}

// ---------------------------------------------------------------------------
// Проверка противоречий

/// Речь персонажей не утверждает канона: кавычки и строки-реплики вырезаются.
fn narrator_voice_only(value: Option<&Value>) -> String {
    let value = js::s(value);
    let value = jstext::replace_all(sk_core::re!(r"«[^»]{0,600}»", "gu"), &value, " ");
    let value = jstext::replace_all(sk_core::re!(r"“[^”]{0,600}”", "gu"), &value, " ");
    let value = jstext::replace_all(sk_core::re!(r"„[^“”]{0,600}[“”]", "gu"), &value, " ");
    let value = jstext::replace_all(sk_core::re!(r#""[^"]{0,600}""#, "gu"), &value, " ");
    let dialogue = sk_core::re!(r"^\s*[—–-]\s", "u");
    value.split('\n').map(|line| if jstext::test(dialogue, line) { " " } else { line }).collect::<Vec<_>>().join("\n")
}

fn clock_minute(clock: Option<&Value>) -> Option<i64> {
    let pattern = sk_core::re!(r"^(\d{1,2}):(\d{2})$", "u");
    let source = js::s(clock);
    let captures = pattern.captures(&source).ok().flatten()?;
    let hours: i64 = captures.get(1)?.as_str().parse().ok()?;
    let minutes: i64 = captures.get(2)?.as_str().parse().ok()?;
    Some(hours * 60 + minutes)
}

/// У границы времени суток слова соседней фазы честны.
const PHASE_BOUNDARY_TOLERANCE_MINUTES: i64 = 45;

fn near_phase_boundary(clock: Option<&Value>) -> bool {
    let Some(minute) = clock_minute(clock) else {
        return false;
    };
    DAY_PHASES.iter().any(|phase| {
        let distance = (minute - phase.start_minute).abs();
        distance.min(1_440 - distance) <= PHASE_BOUNDARY_TOLERANCE_MINUTES
    })
}

type Rule = (&'static str, &'static LazyLock<Vec<Regex>>, &'static str);

fn phase_rules(phase: &str) -> Vec<Rule> {
    match phase {
        "morning" => vec![("night", &NIGHT, "ночь"), ("night", &DARKENING, "наступившую темноту"), ("evening", &EVENING, "вечер и закат")],
        "day" => vec![("night", &NIGHT, "ночь"), ("night", &DARKENING, "наступившую темноту")],
        "evening" => vec![("morning", &MORNING, "утро и рассвет")],
        "night" => vec![("day", &DAY, "солнце и дневной свет"), ("morning", &MORNING, "утро и рассвет"), ("evening", &EVENING, "закатное солнце")],
        _ => Vec::new(),
    }
}

fn weather_rules(weather: &str, indoors: bool) -> Vec<Rule> {
    let mut rules: Vec<Rule> = Vec::new();
    if weather == "clear" || weather == "overcast" {
        rules.extend([("rain", &RAIN, "дождь"), ("storm", &STORM, "грозу"), ("fog", &FOG, "туман")]);
    }
    if weather == "rain" {
        rules.push(("storm", &STORM, "грозу"));
    }
    if weather == "fog" {
        rules.extend([("storm", &STORM, "грозу"), ("rain", &HEAVY_RAIN, "ливень")]);
    }
    if !indoors && ["overcast", "rain", "storm", "fog"].contains(&weather) {
        rules.push(("clear", &CLEAR_SKY, "ясное небо"));
    }
    if !indoors && ["rain", "storm", "fog"].contains(&weather) {
        rules.push(("dry", &DRY, "сухость и пыль"));
    }
    rules
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Shift {
    Time,
    Weather,
    None,
}

struct CheckRule {
    kind: &'static str,
    topic: &'static str,
    patterns: &'static LazyLock<Vec<Regex>>,
    message: String,
    shift: Shift,
    needs_no_opening: bool,
}

/// Прямые противоречия текста канону сцены (`sceneCanonContradictions`):
/// `[{ code, kind, message, match }]`. `options` — `{ events }`: видимые
/// события хода (смена часов, путь, заклинания) законно говорят о другом небе.
pub fn scene_canon_contradictions(narration: Option<&Value>, canon: Option<&Value>, options: Option<&Value>) -> Vec<Value> {
    let Some(canon) = canon.filter(|canon| canon.is_object() || canon.is_array()) else {
        return Vec::new();
    };
    let canon_field = |keys: &[&str]| path(Some(canon), keys);
    let phase = text(canon_field(&["time", "phase"]), 20);
    let weather = text(canon_field(&["weather", "id"]), 20);
    let indoors = js::is_true(canon_field(&["indoors"]));
    let events = array(prop(options, "events"));
    let event_types = events
        .iter()
        .map(|event| js::s(nullish(prop(Some(event), "event_type"), prop(Some(event), "eventType"))))
        .collect::<Vec<_>>()
        .join(" ");
    let payloads: Vec<Value> = events.iter().map(|event| nullish(prop(Some(event), "payload"), None).cloned().unwrap_or_else(|| json!({}))).collect();
    let event_text = head_utf16(&js::stringify(&Value::Array(payloads)), 20_000);

    let mut rules: Vec<CheckRule> = Vec::new();
    let clock = canon_field(&["time", "clock"]);
    let clock_part = if js::truthy(clock) { format!(", {}", js::s(clock)) } else { String::new() };
    let skip_time = skip_for(&SKIPS, "time").is_some_and(|skip| jstext::test(skip, &event_types));
    if !phase.is_empty() && !skip_time && !near_phase_boundary(clock) {
        let label = jstext::lower(&text(canon_field(&["time", "phase_label"]), 20));
        let shown = if label.is_empty() { phase.clone() } else { label };
        for (topic, patterns, what) in phase_rules(&phase) {
            rules.push(CheckRule {
                kind: "time_of_day",
                topic,
                patterns,
                message: format!("Канон сцены: {shown}{clock_part}, а текст описывает {what}"),
                shift: Shift::Time,
                needs_no_opening: false,
            });
        }
    }
    let skip_weather = skip_for(&SKIPS, "weather").is_some_and(|skip| jstext::test(skip, &event_types));
    if !weather.is_empty() && !skip_weather {
        let label = jstext::lower(&text(canon_field(&["weather", "label"]), 20));
        let shown = if label.is_empty() { weather.clone() } else { label };
        let sky = if indoors { "" } else { ", под открытым небом" };
        for (topic, patterns, what) in weather_rules(&weather, indoors) {
            rules.push(CheckRule {
                kind: if topic == "dry" { "surface" } else { "weather" },
                topic,
                patterns,
                message: format!("Канон сцены: {shown}{sky}, а текст описывает {what}"),
                shift: Shift::Weather,
                needs_no_opening: false,
            });
        }
    }
    if indoors {
        rules.push(CheckRule {
            kind: "sky_indoors",
            topic: "sky",
            patterns: &SKY_INDOOR,
            message: "Канон сцены: под крышей, а текст ставит небо над головой".into(),
            shift: Shift::None,
            needs_no_opening: true,
        });
    }
    if rules.is_empty() {
        return Vec::new();
    }

    let mut found = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for (sentence_index, sentence) in sentences_of(&narrator_voice_only(narration)).iter().enumerate() {
        if jstext::test(&SHIFTED, sentence) {
            continue;
        }
        for rule in &rules {
            if skip_for(&TOPIC_SKIPS, rule.topic).is_some_and(|skip| jstext::test(skip, &event_text)) {
                continue;
            }
            if rule.needs_no_opening && jstext::test(&OPENING, sentence) {
                continue;
            }
            for pattern in rule.patterns.iter() {
                for matched in pattern.find_iter(sentence).flatten() {
                    let before = tail_utf16(&sentence[..matched.start()], 28);
                    let after = head_utf16(&sentence[matched.end()..], 40);
                    if jstext::test(&NEGATED, &before) {
                        continue;
                    }
                    let shifted = match rule.shift {
                        Shift::Time => jstext::test(&SHIFTED_TIME, &before),
                        Shift::Weather => jstext::test(&SHIFTED_WEATHER, &before),
                        Shift::None => false,
                    };
                    if shifted {
                        continue;
                    }
                    if jstext::test(&ENDING, &after) || jstext::test(&NEGATED_AFTER, &after) {
                        continue;
                    }
                    if rule.topic == "fog" && jstext::test(&MIND, &format!("{before} {after}")) {
                        continue;
                    }
                    if rule.kind == "weather" {
                        if let Some(adjective) = jstext::capture(&TIME_ADJECTIVE, &before, 1).map(|word| jstext::lower(&word)) {
                            let adjective_phase = match adjective.as_str() {
                                "ночн" => Some("night"),
                                "утренн" => Some("morning"),
                                "дневн" => Some("day"),
                                "вечерн" => Some("evening"),
                                _ => None,
                            };
                            if !adjective.is_empty() && adjective_phase != Some(phase.as_str()) {
                                continue;
                            }
                        }
                        if jstext::test(&FAR_WEATHER, &format!("{before} {} {after}", matched.as_str())) {
                            continue;
                        }
                    }
                    if rule.topic == "dry" && jstext::test(&ENCLOSED_DRY, sentence) {
                        continue;
                    }
                    // Одно предложение — одно нарушение каждого вида.
                    let key = format!("{}:{sentence_index}", rule.kind);
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.push(key);
                    found.push(json!({
                        "code": SCENE_CANON_CONTRADICTION,
                        "kind": rule.kind,
                        "message": rule.message,
                        "match": head_utf16(matched.as_str(), 80),
                    }));
                }
            }
        }
    }
    found
}

/// Почему заранее заготовленное ощущение (сенсорный якорь) не подходит канону
/// (`sensoryAnchorConflicts(anchor, canon)`). Пустой список — подходит.
pub fn sensory_anchor_conflicts(anchor: Option<&Value>, canon: Option<&Value>) -> Vec<String> {
    let Some(canon) = canon.filter(|canon| js::truthy(Some(canon))) else {
        return Vec::new();
    };
    let mut reasons: Vec<String> = scene_canon_contradictions(anchor, Some(canon), None)
        .iter()
        .map(|found| js::s(found.get("kind")))
        .collect();
    // `regex.test(anchor)` приводит аргумент `String(anchor)`: `undefined` — «undefined».
    let tested = js::string(anchor);
    let outdoors = js::is_false(prop(Some(canon), "indoors"));
    if outdoors && jstext::test(&INDOOR_ONLY, &tested) {
        reasons.push("indoor_detail_outdoors".into());
    }
    let wetness = js::s(path(Some(canon), &["surfaces", "wetness"]));
    if outdoors && (wetness == "wet" || wetness == "damp") && jstext::test(&DRY_WORD, &tested) {
        reasons.push("dry_detail_in_wet_weather".into());
    }
    reasons
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Все выражения, снятые с JS, собираются движком (в том числе
    /// lookbehind переменной длины у «Ясно.»).
    #[test]
    fn every_pattern_compiles() {
        let _ = (&*WATER_PLACE, &*PHASE_WORDS, &*WEATHER_WORDS, &*SHIFT_PREFIX, &*WEATHER_SHIFT_PREFIX, &*OPENING_SHIFTED);
        let _ = (&*NIGHT, &*DARKENING, &*DAY, &*MORNING, &*EVENING, &*RAIN, &*HEAVY_RAIN, &*STORM, &*FOG, &*CLEAR_SKY, &*DRY, &*SKY_INDOOR);
        let _ = (&*SHIFTED, &*NEGATED, &*SHIFTED_TIME, &*SHIFTED_WEATHER, &*ENDING, &*MIND, &*NEGATED_AFTER, &*TIME_ADJECTIVE);
        let _ = (&*FAR_WEATHER, &*ENCLOSED_DRY, &*OPENING, &*SKIPS, &*TOPIC_SKIPS, &*INDOOR_ONLY, &*DRY_WORD);
    }

    #[test]
    fn tail_counts_utf16_units() {
        assert_eq!(tail_utf16("ab😀c", 3), "😀c");
        assert_eq!(tail_utf16("ab😀c", 2), "c");
        assert_eq!(tail_utf16("abc", 10), "abc");
    }

    #[test]
    fn sentences_split_after_punctuation() {
        assert_eq!(sentences_of("Ночь. Утро!  День\n\nвечер"), vec!["Ночь.", "Утро!", "День", "вечер"]);
    }
}

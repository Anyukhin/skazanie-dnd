//! Перенос `server/agent-context.mjs` — общий контекст для агентов-моделей:
//! что видно в сцене действующему лицу, сводка поля, карточка героя, замысел
//! кампании и метаданные вызова.
//!
//! Модуль ничего не вызывает и не пишет: он собирает из состояния то, что
//! агенту можно знать. Видимое — только на раскрытых клетках карты; противник
//! за нераскрытой клеткой не называется; незнакомого жителя рассказчик зовёт
//! по роли; замысел кампании — через `questStateForViewer`, то есть без
//! скрытых историй. Чисел здоровья нет: состояние — словами, как видит игрок.
//!
//! Якоря программы сцены (этап 7 `docs/map-generation-plan.md`): что из
//! обещанного текстом стоит на карте и в какой стороне от героя, и что текст
//! обещал, а карта не держит, — Рассказчик об этом молчит.

use std::collections::HashSet;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{js, text};
use sk_map_core::map_quality::platform_cells;
use sk_scene_base::scene_requirements::{normalize_scene_requirements, requirement_assets, requirement_label, requirement_terrain};
use sk_society::campaign_stories::campaign_mode_for;
use sk_society::quest_consequences::quest_state_for_viewer;
use sk_tactical::tactical_map::{cell_at, deserialize_tactical_map, TacticalCell, TacticalMap, TacticalZone};

use sk_core::v8math;

/// `AGENT_CONTEXT_SCHEMA_VERSION`.
pub const AGENT_CONTEXT_SCHEMA_VERSION: i64 = 1;
/// `SPATIAL_CONTEXT_SCHEMA_VERSION`.
pub const SPATIAL_CONTEXT_SCHEMA_VERSION: i64 = 2;

// --- приведения JS -------------------------------------------------------------

fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value?, |current, key| field(Some(current), key))
}

fn array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// `a ?? b ?? …`: первое присутствующее и не `null`; иначе последнее как есть
/// (`undefined ?? null` — `null`, и `Number(null)` — ноль).
fn coalesce<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|value| js::present(*value)).unwrap_or_else(|| values.last().copied().flatten())
}

/// `a || b`: первое истинное, иначе последнее.
fn or<'a>(left: Option<&'a Value>, right: Option<&'a Value>) -> Option<&'a Value> {
    if js::truthy(left) {
        left
    } else {
        right
    }
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, max)` в единицах UTF-16; символ вне BMP, который JS разрезал
/// бы пополам, отбрасывается целиком.
fn head_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in text.chars() {
        let width = ch.len_utf16();
        if units + width > max {
            break;
        }
        units += width;
        out.push(ch);
    }
    out
}

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    clean_str(&js::s(value), maximum)
}

fn clean_str(value: &str, maximum: usize) -> String {
    head_utf16(&text::squash_spaces(&text::nfkc(value)), maximum)
}

/// `Number(value) || fallback`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if number.is_nan() || number == 0.0 {
        fallback
    } else {
        number
    }
}

/// `a === b` над JSON: примитивы по значению, объекты никогда, `undefined === undefined`.
fn strict_eq(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        _ => false,
    }
}

/// `cellAt(map, x, y)` для чисел JS: нецелая координата — клетки нет.
fn cell_at_number(map: &TacticalMap, x: f64, y: f64) -> Option<TacticalCell<'_>> {
    let integer = |value: f64| value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15;
    if !integer(x) || !integer(y) {
        return None;
    }
    cell_at(map, x as i64, y as i64)
}

fn safe_identifier(value: Option<&Value>, maximum: usize) -> Value {
    let result = clean(value, maximum);
    if result.is_empty() {
        Value::Null
    } else {
        Value::String(result)
    }
}

// --- метаданные --------------------------------------------------------------

/// Поля вызова `agentContextMetadata(state, { role, actorId, targetId, contractVersion })`.
#[derive(Clone, Copy, Debug, Default)]
pub struct AgentContextOptions<'a> {
    pub role: Option<&'a Value>,
    pub actor_id: Option<&'a Value>,
    pub target_id: Option<&'a Value>,
    pub contract_version: Option<&'a Value>,
}

fn safe_state_version(state: &Value) -> Value {
    let value = js::number(coalesce(&[field(Some(state), "state_version"), field(Some(state), "stateVersion"), field(Some(state), "version")]));
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 && value >= 0.0 {
        js::num(value)
    } else {
        Value::Null
    }
}

fn campaign_id_for(state: &Value) -> Value {
    let state = Some(state);
    safe_identifier(coalesce(&[field(state, "sessionCode"), field(state, "campaign_id"), field(state, "campaignId"), path(state, &["campaign", "id"])]), 120)
}

/// `agentContextMetadata(state, options)`: метаданные вызова принадлежат
/// серверу и не принимаются из ответа модели — они привязывают ответ к роли,
/// актёру, кампании, версии состояния и контракту роли.
///
/// `state: null` в JS — `TypeError`; здесь не-объект читается как пустой.
pub fn agent_context_metadata(state: &Value, options: &AgentContextOptions<'_>) -> Value {
    let role = clean(options.role.or(Some(&Value::String("unknown".into()))), 80);
    json!({
        "role": if role.is_empty() { "unknown".to_string() } else { role },
        "actor_id": safe_identifier(options.actor_id, 120),
        "target_id": safe_identifier(options.target_id, 120),
        "campaign_id": campaign_id_for(state),
        "state_version": safe_state_version(state),
        "contract_version": safe_identifier(options.contract_version, 80),
        "schema_version": AGENT_CONTEXT_SCHEMA_VERSION,
    })
}

/// Поля вызова `boundedSelectionMetadata({ scope, candidateCount, limit, sourceAvailable })`.
#[derive(Clone, Copy, Debug, Default)]
pub struct SelectionOptions<'a> {
    pub scope: Option<&'a Value>,
    pub candidate_count: Option<&'a Value>,
    pub limit: Option<&'a Value>,
    /// `None` — `undefined`, по умолчанию источник доступен.
    pub source_available: Option<&'a Value>,
}

/// `boundedSelectionMetadata(options)`: метаданные ограниченной выборки.
/// `candidate_count` считается уже после фильтра доступности, поэтому
/// скрытые записи на полноту не влияют.
pub fn bounded_selection_metadata(options: &SelectionOptions<'_>) -> Value {
    let bounded_limit = 0.0_f64.max(number_or(options.limit, 0.0));
    let scope = clean(options.scope, 160);
    let available = options.source_available.is_none_or(|value| js::truthy(Some(value)));
    if !available {
        return json!({
            "scope": scope, "status": "unavailable", "availability": "unavailable",
            "complete_within_scope": null, "truncation_reason": "source_unavailable",
        });
    }
    let count = 0.0_f64.max(number_or(options.candidate_count, 0.0));
    let truncated = count > bounded_limit;
    let mut result = Map::new();
    result.insert("scope".into(), Value::String(scope));
    result.insert("status".into(), Value::from(if truncated { "truncated" } else if count != 0.0 { "complete" } else { "empty" }));
    result.insert("availability".into(), Value::from("available"));
    result.insert("complete_within_scope".into(), Value::Bool(!truncated));
    if truncated {
        result.insert("truncation_reason".into(), Value::from("item_limit"));
    }
    Value::Object(result)
}

fn selection(scope: &str, count: usize, limit: usize, available: bool) -> Value {
    let scope = Value::from(scope);
    let count = Value::from(count);
    let limit = Value::from(limit);
    let unavailable = Value::Bool(false);
    bounded_selection_metadata(&SelectionOptions {
        scope: Some(&scope),
        candidate_count: Some(&count),
        limit: Some(&limit),
        source_available: if available { None } else { Some(&unavailable) },
    })
}

/// `selectionFields(metadata, prefix)`: поля выборки с префиксом.
fn insert_selection_fields(target: &mut Map<String, Value>, metadata: &Value, prefix: &str) {
    for key in ["scope", "status", "availability", "complete_within_scope"] {
        target.insert(format!("{prefix}_{key}"), metadata.get(key).cloned().unwrap_or(Value::Null));
    }
    if js::truthy(metadata.get("truncation_reason")) {
        target.insert(format!("{prefix}_truncation_reason"), metadata["truncation_reason"].clone());
    }
}

fn unavailable_spatial_context() -> Value {
    let objects = selection("visible_interactable_objects_in_current_area", 0, 0, false);
    let areas = selection("visible_discovered_areas_in_current_location", 0, 0, false);
    let mut context = Map::new();
    context.insert("schema_version".into(), Value::from(SPATIAL_CONTEXT_SCHEMA_VERSION));
    context.insert("current_area".into(), Value::Null);
    context.insert("known_areas".into(), json!([]));
    context.insert("known_area_ids".into(), json!([]));
    context.insert("objects".into(), json!([]));
    insert_selection_fields(&mut context, &areas, "known_areas");
    insert_selection_fields(&mut context, &objects, "objects");
    Value::Object(context)
}

// --- канон и имена -------------------------------------------------------------

/// `sceneCanonFor(state)`: установленные публичные факты исходной ситуации
/// (`scene_canon`), которых держатся рассказчик, NPC и судья заявок.
pub fn scene_canon_for(state: &Value) -> Vec<String> {
    array(path(Some(state), &["worldMemory", "facts"]))
        .iter()
        .filter(|fact| {
            field(Some(fact), "predicate").and_then(Value::as_str) == Some("scene_canon")
                && field(Some(fact), "status").and_then(Value::as_str) != Some("superseded")
                && field(Some(fact), "visibility").and_then(Value::as_str) == Some("party")
        })
        .map(|fact| clean(field(Some(fact), "summary"), 220))
        .filter(|summary| !summary.is_empty())
        .take(8)
        .collect()
}

/// `toLocaleLowerCase('ru').replace(/ё/gu, 'е')`.
fn folded(text: &str) -> String {
    text::lower(text).replace('ё', "е")
}

/// `npcKnownByName(state, npc)`: знает ли отряд этого NPC по имени — говорил с
/// ним, имя звучало в летописи или его назвал открытый факт мира.
pub fn npc_known_by_name(state: &Value, npc: &Value) -> bool {
    let id = js::s(field(Some(npc), "id"));
    if !id.is_empty() && array(path(Some(state), &["social", "conversations"])).iter().any(|entry| js::s(field(Some(entry), "npc_id")) == id) {
        return true;
    }
    let name = clean(field(Some(npc), "name"), 80);
    let first = name.split(' ').next().unwrap_or("");
    let first_length = utf16_len(first);
    if first_length < 3 {
        return true;
    }
    let stem = head_utf16(&folded(first), 3.max(first_length - 1));
    let mentions = |value: Option<&Value>| folded(&js::s(value)).contains(&stem);
    if array(field(Some(state), "messages")).iter().any(|message| mentions(field(Some(message), "text"))) {
        return true;
    }
    array(path(Some(state), &["worldMemory", "facts"]))
        .iter()
        .any(|fact| matches!(js::string(field(Some(fact), "visibility")).as_str(), "party" | "public") && mentions(field(Some(fact), "summary")))
}

// --- сводка поля ---------------------------------------------------------------

/// Состояние словами стола (`HEALTH_WORDS` по собственному ключу).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Condition {
    Text(&'static str),
}

impl Condition {
    fn to_json(self) -> Option<Value> {
        match self {
            Self::Text(text) => Some(Value::from(text)),
        }
    }
}

const HEALTH_WORDS: [(&str, &str); 5] =
    [("unharmed", "цел"), ("wounded", "ранен"), ("bloodied", "тяжело ранен"), ("critical", "едва стоит"), ("defeated", "выбыл")];

/// `healthWord(actor, { hero, dead })`.
fn health_word(actor: &Value, hero: bool, dead: bool) -> Condition {
    if dead {
        return Condition::Text("погиб");
    }
    let actor = Some(actor);
    let out = if hero { "без сознания" } else { "выбыл" };
    if !js::present(field(actor, "hp")) && !js::present(field(actor, "maxHp")) {
        if js::is_false(field(actor, "alive")) {
            return Condition::Text(out);
        }
        let key = js::s(field(actor, "healthStatus"));
        if let Some((_, word)) = HEALTH_WORDS.iter().find(|(status, _)| *status == key) {
            return Condition::Text(word);
        }
        return Condition::Text("цел");
    }
    let hp = 0.0_f64.max(number_or(field(actor, "hp"), 0.0));
    let maximum = 1.0_f64.max(number_or(coalesce(&[field(actor, "maxHp"), field(actor, "max_hp")]), 1.0));
    if hp <= 0.0 || js::is_false(field(actor, "alive")) {
        return Condition::Text(out);
    }
    let ratio = hp / maximum;
    Condition::Text(if ratio >= 1.0 {
        "цел"
    } else if ratio > 0.5 {
        "ранен"
    } else if ratio > 0.25 {
        "тяжело ранен"
    } else {
        "едва стоит"
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Heroes,
    Enemies,
    People,
}

struct Entry {
    side: Side,
    name: String,
    at: (f64, f64),
    area: Option<(String, bool)>,
    condition: Option<Condition>,
    unknown_name: bool,
}

/// Зона по id: `new Map(zones.map(...))` — при повторе побеждает последняя.
fn zone_by_id<'m>(map: &'m TacticalMap, id: &str) -> Option<&'m TacticalZone> {
    map.zones.iter().rev().find(|zone| zone.id == id)
}

/// `fieldSummaryFor(state, preparedMap)`: кто где стоит (часть места, под
/// крышей или нет), в каком состоянии и кто с кем рядом. Противники — только
/// на раскрытых клетках; незнакомый житель — по роли. `None` — карты нет.
pub fn field_summary_for(state: &Value, prepared_map: Option<&TacticalMap>) -> Option<Value> {
    let scene = field(Some(state), "scene");
    let owned;
    let map = match prepared_map {
        Some(map) => map,
        None => {
            let raw = field(scene, "map").filter(|raw| js::truthy(Some(raw)) && (raw.is_object() || raw.is_array()))?;
            owned = deserialize_tactical_map(raw).ok()?;
            &owned
        }
    };
    let position_of = |id: &str, actor: &Value| {
        let stored = path(Some(state), &["mechanics", "positions", id]);
        let coordinate = |key: &str| js::number(coalesce(&[field(stored, key), field(Some(actor), key)]));
        let (x, y) = (coordinate("x"), coordinate("y"));
        (x.is_finite() && y.is_finite()).then_some((x, y))
    };
    let area_of = |at: (f64, f64)| {
        let cell = cell_at_number(map, at.0, at.1)?;
        let zone = zone_by_id(map, cell.zone)?;
        let label = if zone.label.is_empty() { zone.kind.as_str() } else { zone.label.as_str() };
        Some((clean_str(label, 80), zone.kind == "interior"))
    };
    let dead = path(Some(state), &["mechanics", "death", "heroes"]);
    let mut entries: Vec<Entry> = Vec::new();
    for hero in array(field(Some(state), "players")) {
        let id = js::string(field(Some(hero), "id"));
        let Some(at) = position_of(&id, hero) else { continue };
        let is_dead = path(dead, &[&id, "status"]).and_then(Value::as_str) == Some("dead");
        entries.push(Entry {
            side: Side::Heroes,
            name: clean(or(field(Some(hero), "character"), field(Some(hero), "name")), 80),
            at,
            area: area_of(at),
            condition: Some(health_word(hero, true, is_dead)),
            unknown_name: false,
        });
    }
    let combat_active = js::truthy(path(Some(state), &["mechanics", "combat", "active"]));
    for enemy in array(field(Some(state), "enemies")) {
        let id = js::string(field(Some(enemy), "id"));
        let Some(at) = position_of(&id, enemy) else { continue };
        if !cell_at_number(map, at.0, at.1).is_some_and(|cell| cell.revealed) {
            continue;
        }
        let condition = health_word(enemy, false, false);
        if condition == Condition::Text("выбыл") && !combat_active {
            continue;
        }
        entries.push(Entry { side: Side::Enemies, name: clean(field(Some(enemy), "name"), 80), at, area: area_of(at), condition: Some(condition), unknown_name: false });
    }
    let here = clean(field(scene, "location_id"), 120);
    let npcs = array(path(Some(state), &["social", "npcs"]));
    for placement in array(path(Some(state), &["npc_world", "placements"])) {
        if !here.is_empty() && clean(field(Some(placement), "location_id"), 120) != here {
            continue;
        }
        let npc_id = js::string(field(Some(placement), "npc_id"));
        let Some(npc) = npcs.iter().find(|entry| js::string(field(Some(entry), "id")) == npc_id) else { continue };
        if js::is_false(field(Some(npc), "available")) {
            continue;
        }
        let at = (js::number(field(Some(placement), "x")), js::number(field(Some(placement), "y")));
        if !at.0.is_finite() || !at.1.is_finite() {
            continue;
        }
        // Незнакомого — по роли: имени отряд ещё не слышал.
        let known = npc_known_by_name(state, npc);
        let name = if known {
            clean(field(Some(npc), "name"), 80)
        } else {
            let role = clean(field(Some(npc), "role"), 80);
            if role.is_empty() {
                "незнакомец".to_string()
            } else {
                role
            }
        };
        entries.push(Entry { side: Side::People, name, at, area: area_of(at), condition: None, unknown_name: !known });
    }
    let shape = |index: usize| {
        let entry = &entries[index];
        let close: Vec<Value> = entries
            .iter()
            .enumerate()
            .filter(|(other, candidate)| *other != index && (candidate.at.0 - entry.at.0).abs().max((candidate.at.1 - entry.at.1).abs()) <= 1.0)
            .map(|(_, candidate)| Value::from(candidate.name.as_str()))
            .take(6)
            .collect();
        let mut object = Map::new();
        object.insert("name".into(), Value::from(entry.name.as_str()));
        if let Some((area, indoors)) = &entry.area {
            object.insert("area".into(), Value::from(area.as_str()));
            object.insert("indoors".into(), Value::Bool(*indoors));
        }
        if let Some(condition) = entry.condition.and_then(Condition::to_json) {
            object.insert("condition".into(), condition);
        }
        if entry.unknown_name {
            object.insert("known_by_name".into(), Value::Bool(false));
        }
        if !close.is_empty() {
            object.insert("next_to".into(), Value::Array(close));
        }
        Value::Object(object)
    };
    let side = |wanted: Side, limit: usize| -> Vec<Value> { (0..entries.len()).filter(|index| entries[*index].side == wanted).map(shape).take(limit).collect() };
    Some(json!({
        "heroes": side(Side::Heroes, 8),
        "enemies": side(Side::Enemies, 12),
        "people": side(Side::People, 8),
    }))
}

// --- обстановка у действующего лица ----------------------------------------------

/// Сторона света от героя до якоря: север вверху карты. `None` — направление
/// не определено (`NaN` в JS, и поле `where` из JSON пропадает).
fn direction_word(dx: f64, dy: f64) -> Option<&'static str> {
    if v8math::hypot(dx, dy) <= 3.0 {
        return Some("рядом");
    }
    let angle = v8math::atan2(-dy, dx) * 180.0 / std::f64::consts::PI;
    const SECTORS: [&str; 8] = ["к востоку", "к северо-востоку", "к северу", "к северо-западу", "к западу", "к юго-западу", "к югу", "к юго-востоку"];
    let index = js::round(((angle + 360.0) % 360.0) / 45.0) % 8.0;
    (index.is_finite() && index >= 0.0).then(|| SECTORS.get(index as usize).copied()).flatten()
}

/// `sceneLandmarks(scene, map, position)`: якоря программы сцены — что из
/// обещанного стоит на раскрытых клетках и в какой стороне, и что текст
/// обещал, а карты нет. `None` — программы нет.
fn scene_landmarks(scene: Option<&Value>, map: &TacticalMap, position: Option<(f64, f64)>) -> Option<(Vec<Value>, Vec<Value>)> {
    let requirements = field(scene, "map_requirements");
    let items = normalize_scene_requirements(requirements.unwrap_or(&Value::Null));
    let missing_raw = field(requirements, "missing").and_then(Value::as_array);
    // Программа без предметов, но с недостроенной постройкой тоже говорит
    // Рассказчику, о чём молчать.
    if items.is_empty() && missing_raw.is_none_or(|missing| missing.is_empty()) {
        return None;
    }
    let origin = position.unwrap_or_else(|| {
        map.spawn_points.iter().find(|point| point.role == "party").map_or((map.width as f64 / 2.0, map.height as f64 / 2.0), |point| (point.x as f64, point.y as f64))
    });
    let focus = field(requirements, "focus");
    let mut landmarks = Vec::new();
    let mut absent: Vec<String> = Vec::new();
    for item in &items {
        let terrain = requirement_terrain(&item.id);
        let all: Vec<Vec<(f64, f64)>> = if terrain.is_some() {
            platform_cells(map).into_iter().map(|(x, y)| vec![(x as f64, y as f64)]).collect()
        } else {
            let assets: HashSet<&str> = requirement_assets(&item.id).into_iter().collect();
            map.props
                .iter()
                .filter(|prop| assets.contains(prop.asset_id.as_str()))
                .map(|prop| {
                    if prop.footprint.is_empty() {
                        vec![(prop.x.floor(), prop.y.floor())]
                    } else {
                        prop.footprint.iter().map(|point| (point.x as f64, point.y as f64)).collect()
                    }
                })
                .collect()
        };
        if all.is_empty() {
            absent.push(item.id.clone());
            continue;
        }
        let visible: Vec<&Vec<(f64, f64)>> = all.iter().filter(|cells| cells.iter().all(|point| cell_at_number(map, point.0, point.1).is_some_and(|cell| cell.revealed))).collect();
        if visible.is_empty() {
            continue;
        }
        let points: Vec<(f64, f64)> = visible.iter().flat_map(|cells| cells.iter().copied()).collect();
        let cx = points.iter().fold(0.0, |sum, point| sum + point.0) / points.len() as f64;
        let cy = points.iter().fold(0.0, |sum, point| sum + point.1) / points.len() as f64;
        let mut landmark = Map::new();
        landmark.insert("kind".into(), Value::from(item.id.as_str()));
        landmark.insert("label".into(), Value::from(requirement_label(&item.id)));
        let count = if terrain.is_some() { 1.0_f64.max(js::round(visible.len() as f64 / 6.0)) } else { visible.len() as f64 };
        landmark.insert("count".into(), js::num(count));
        if let Some(word) = direction_word(cx - origin.0, cy - origin.1) {
            landmark.insert("where".into(), Value::from(word));
        }
        if focus.and_then(Value::as_str) == Some(item.id.as_str()) {
            landmark.insert("focus".into(), Value::Bool(true));
        }
        landmarks.push(Value::Object(landmark));
    }
    let missing: Vec<String> = missing_raw.map(|missing| missing.iter().map(|id| js::string(Some(id))).collect()).unwrap_or_default();
    let unique: IndexSet<String> = absent.into_iter().chain(missing).collect();
    let landmarks_absent = unique.into_iter().map(|id| json!({ "kind": id, "label": requirement_label(&id) })).take(12).collect();
    landmarks.truncate(12);
    Some((landmarks, landmarks_absent))
}

/// Позиция действующего лица: `positions[id] ?? actor ?? placement`.
struct Position {
    truthy: bool,
    x: f64,
    y: f64,
}

fn position_from(value: &Value) -> Position {
    Position { truthy: js::truthy(Some(value)), x: js::number(field(Some(value), "x")), y: js::number(field(Some(value), "y")) }
}

/// `sceneContextForAgent(state, actorId)`: видимая обстановка у действующего
/// лица, без скрытых комнат и бинарных слоёв карты.
pub fn scene_context_for_agent(state: &Value, actor_id: Option<&Value>) -> Value {
    let scene = field(Some(state), "scene");
    let mut context = Map::new();
    for key in ["title", "location", "mood", "objective", "theme", "scene_kind", "layout"] {
        let value = clean(field(scene, key), if key == "layout" { 400 } else { 300 });
        if key != "layout" || !value.is_empty() {
            context.insert(key.into(), Value::String(value));
        }
    }
    // Что карта мира обещает об этом месте.
    let world_map = field(Some(state), "worldMap");
    let current_location = js::s(field(world_map, "currentLocationId"));
    let location_name = text::lower(&clean(field(scene, "location"), 160));
    let place = array(field(world_map, "locations")).iter().find(|entry| {
        !js::is_false(field(Some(entry), "known"))
            && (js::s(field(Some(entry), "id")) == current_location || text::lower(&clean(field(Some(entry), "name"), 160)) == location_name)
    });
    let place_summary = clean(field(place, "summary"), 300);
    if !place_summary.is_empty() {
        context.insert("place_summary".into(), Value::String(place_summary));
    }
    let canon = scene_canon_for(state);
    if !canon.is_empty() {
        context.insert("canon".into(), json!(canon));
    }
    let role = Value::from("scene_context");
    let contract = Value::from("scene-context/v2");
    let metadata = agent_context_metadata(state, &AgentContextOptions { role: Some(&role), actor_id, target_id: None, contract_version: Some(&contract) });
    let unavailable = |mut context: Map<String, Value>| {
        context.insert("context_metadata".into(), metadata.clone());
        context.insert("spatial_context".into(), unavailable_spatial_context());
        Value::Object(context)
    };
    let Some(raw_map) = field(scene, "map").filter(|raw| js::truthy(Some(raw)) && (raw.is_object() || raw.is_array())) else {
        return unavailable(context);
    };
    // После разбора слои всегда типизированы, а размеры — целые: проверка
    // `requiredLayers` JS здесь не нужна.
    let Ok(map) = deserialize_tactical_map(raw_map) else { return unavailable(context) };

    let id = [actor_id, field(Some(state), "activePlayerId")].into_iter().find(|value| js::truthy(*value)).flatten().map(|value| js::string(Some(value))).unwrap_or_default();
    let actor = array(field(Some(state), "players"))
        .iter()
        .chain(array(field(Some(state), "actors")))
        .find(|entry| field(Some(entry), "id").and_then(Value::as_str) == Some(id.as_str()));
    let positions = path(Some(state), &["mechanics", "positions"]);
    let position = match positions.and_then(Value::as_object).and_then(|positions| positions.get(&id)).filter(|value| !value.is_null()) {
        Some(stored) => Some(position_from(stored)),
        None => actor.map(position_from).or_else(|| {
            array(path(Some(state), &["npc_world", "placements"]))
                .iter()
                .find(|entry| field(Some(entry), "npc_id").and_then(Value::as_str) == Some(id.as_str()) && strict_eq(field(Some(entry), "location_id"), field(scene, "location_id")))
                .map(position_from)
        }),
    };
    let position = position.filter(|position| position.truthy);
    let at = position.as_ref().and_then(|position| cell_at_number(&map, position.x, position.y));
    let current_zone = at.as_ref().filter(|cell| cell.revealed).and_then(|cell| map.zones.iter().find(|zone| zone.id == cell.zone));
    let mut discovered: HashSet<String> = HashSet::new();
    for y in 0..map.height {
        for x in 0..map.width {
            if let Some(cell) = cell_at(&map, x, y) {
                if cell.revealed && cell.passable && !cell.zone.is_empty() {
                    discovered.insert(cell.zone.to_string());
                }
            }
        }
    }
    // `prop.visibility` у предмета разобранной карты не бывает (поле не
    // переносится), поэтому фильтр `gm_only`/`npc_private` JS всегда пропускает.
    let mut visible_objects: Vec<_> = map
        .props
        .iter()
        .filter(|prop| {
            let Some(cell) = cell_at_number(&map, prop.x.floor(), prop.y.floor()) else { return false };
            let footprint_visible = prop.footprint.is_empty() || prop.footprint.iter().all(|point| cell_at(&map, point.x, point.y).is_some_and(|cell| cell.revealed));
            cell.revealed && current_zone.is_none_or(|zone| cell.zone == zone.id) && footprint_visible && !matches!(prop.state.as_str(), "broken" | "destroyed")
        })
        .collect();
    match &position {
        Some(position) => {
            let distance = |prop: &&sk_tactical::tactical_map::TacticalProp| v8math::hypot(prop.x - position.x, prop.y - position.y);
            visible_objects.sort_by(|left, right| {
                let difference = distance(left) - distance(right);
                difference.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        None => visible_objects.sort_by(|left, right| text::locale_compare(&left.id, &right.id)),
    }
    let objects: Vec<Value> = visible_objects
        .iter()
        .take(16)
        .map(|prop| json!({ "id": clean_str(&prop.id, 120), "kind": prop.asset_id, "x": js::num(prop.x), "y": js::num(prop.y), "state": prop.state }))
        .collect();
    let visible_areas: Vec<&TacticalZone> = map.zones.iter().filter(|zone| discovered.contains(&zone.id) && !zone.label.is_empty()).collect();
    let object_selection = selection("visible_interactable_objects_in_current_area", visible_objects.len(), 16, true);
    let area_selection = selection("visible_discovered_areas_in_current_location", visible_areas.len(), 16, true);
    let program = scene_landmarks(scene, &map, position.as_ref().map(|position| (position.x, position.y)));
    let field_summary = field_summary_for(state, Some(&map));

    let mut result = context;
    if let Some((landmarks, absent)) = program {
        result.insert("landmarks".into(), Value::Array(landmarks));
        result.insert("landmarks_absent".into(), Value::Array(absent));
    }
    if let Some(summary) = field_summary.filter(|summary| ["heroes", "enemies", "people"].iter().any(|key| summary[*key].as_array().is_some_and(|list| !list.is_empty()))) {
        result.insert("field".into(), summary);
    }
    result.insert("context_metadata".into(), metadata);
    if let Some(zone) = current_zone {
        let location = or(field(scene, "location_id"), field(scene, "location"));
        result.insert("id".into(), Value::String(format!("{}:{}", js::string(location), zone.id)));
        let theme = if zone.label.is_empty() { zone.kind.clone() } else { zone.label.clone() };
        result.insert("theme".into(), Value::String(theme));
    }
    let mut spatial = Map::new();
    spatial.insert("schema_version".into(), Value::from(SPATIAL_CONTEXT_SCHEMA_VERSION));
    spatial.insert("current_area".into(), current_zone.map_or(Value::Null, |zone| json!({ "name": zone.label, "indoors": zone.kind == "interior" })));
    spatial.insert("known_areas".into(), Value::Array(visible_areas.iter().take(16).map(|zone| Value::from(zone.label.as_str())).collect()));
    spatial.insert(
        "known_area_ids".into(),
        Value::Array(visible_areas.iter().take(16).map(|zone| clean_str(&zone.id, 120)).filter(|id| !id.is_empty()).map(Value::String).collect()),
    );
    spatial.insert("objects".into(), Value::Array(objects));
    insert_selection_fields(&mut spatial, &area_selection, "known_areas");
    insert_selection_fields(&mut spatial, &object_selection, "objects");
    result.insert("spatial_context".into(), Value::Object(spatial));
    Value::Object(result)
}

// --- карточка героя и замысел кампании ------------------------------------------

/// Заглушки незаполненного листа героя: в карточку они не идут.
const HERO_CARD_PLACEHOLDERS: [&str; 5] = ["не выбран", "не выбрано", "не определено", "ожидает игрока", "герой ещё не создан"];

/// `lastIndexOf(needle)` в единицах UTF-16; −1 — не найдено.
fn last_index_utf16(haystack: &str, needle: &str) -> i64 {
    haystack.rfind(needle).map_or(-1, |byte| utf16_len(&haystack[..byte]) as i64)
}

/// Текст карточки, обрезанный по концу предложения, а не на полуслове.
fn hero_card_text(value: Option<&Value>, maximum: usize) -> String {
    let text = clean(value, 8_000);
    if text.is_empty() || HERO_CARD_PLACEHOLDERS.contains(&text::lower(&text).as_str()) {
        return String::new();
    }
    if utf16_len(&text) <= maximum {
        return text;
    }
    let cut = head_utf16(&text, maximum);
    let sentence_end = [". ", "! ", "? ", "… "].iter().map(|needle| last_index_utf16(&cut, needle)).max().unwrap_or(-1);
    if sentence_end as f64 >= maximum as f64 / 2.0 {
        // Конец предложения — символ BMP, граница — граница символа.
        return head_utf16(&cut, sentence_end as usize + 1);
    }
    format!("{}…", text::replace_first(sk_core::re!(r"\s+\S*$", "u"), &cut, ""))
}

/// `heroCardForAgent(state, heroId)`: имя, класс, предыстория (до 300 знаков)
/// и привязанности героя — то, что видно отряду на листе героя.
pub fn hero_card_for_agent(state: &Value, hero_id: Option<&Value>) -> Option<Value> {
    let expected = js::s(hero_id);
    let hero = array(field(Some(state), "players")).iter().find(|player| js::s(field(Some(player), "id")) == expected)?;
    let hero = Some(hero);
    let role_text = js::s(field(hero, "role"));
    let role = hero_card_text(Some(&Value::String(role_text.split('·').next().unwrap_or("").to_string())), 80);
    let class = if role.is_empty() { hero_card_text(field(hero, "characterClass"), 60) } else { role };
    let card = [
        ("id", clean(field(hero, "id"), 120)),
        ("name", hero_card_text(or(field(hero, "character"), field(hero, "name")), 120)),
        ("class", class),
        ("species", hero_card_text(field(hero, "species"), 80)),
        ("background", hero_card_text(field(hero, "background"), 120)),
        ("backstory", hero_card_text(field(hero, "backstory"), 300)),
        ("bonds", hero_card_text(field(hero, "bonds"), 200)),
        ("ideals", hero_card_text(field(hero, "ideals"), 160)),
    ];
    Some(Value::Object(card.into_iter().filter(|(_, value)| !value.is_empty()).map(|(key, value)| (key.to_string(), Value::String(value))).collect()))
}

/// `positiveInteger(value)`: целое больше нуля или `null`.
fn positive_integer(value: Option<&Value>) -> Value {
    let number = js::number(value);
    if number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 && number > 0.0 {
        js::num(number)
    } else {
        Value::Null
    }
}

/// `arr.slice(-n)`.
fn last_n(items: &[Value], n: usize) -> &[Value] {
    &items[items.len().saturating_sub(n)..]
}

/// `campaignConceptForAgent(state, viewer)`: публичный ограниченный замысел
/// кампании, общий для всех творческих агентов; `viewer` по умолчанию —
/// участник отряда.
pub fn campaign_concept_for_agent(state: &Value, viewer: Option<&Value>) -> Value {
    let default_viewer = json!({ "isPartyMember": true });
    let visible = quest_state_for_viewer(state, viewer.unwrap_or(&default_viewer));
    let empty = Value::Object(Map::new());
    let concept = coalesce(&[field(Some(&visible), "campaignConcept"), field(Some(&visible), "campaign_concept")]).unwrap_or(&empty);
    let concept = Some(concept);
    let arc_history: Vec<Value> = last_n(array(field(concept, "arc_history")), 3)
        .iter()
        .map(|entry| {
            json!({
                "arc_number": positive_integer(field(Some(entry), "arc_number")),
                "title": clean(field(Some(entry), "title"), 160),
                "epilogue": clean(field(Some(entry), "epilogue"), 1_200),
                "concluded_at": clean(field(Some(entry), "concluded_at"), 80),
            })
        })
        .filter(|entry| js::truthy(entry.get("arc_number")) && js::truthy(entry.get("epilogue")))
        .collect();
    let factions: Vec<Value> = array(field(concept, "factions"))
        .iter()
        .take(6)
        .map(|entry| {
            json!({
                "id": clean(field(Some(entry), "id"), 80),
                "name": clean(field(Some(entry), "name"), 120),
                "summary": clean(field(Some(entry), "summary"), 360),
                "goal": clean(field(Some(entry), "goal"), 240),
            })
        })
        .filter(|entry| ["id", "name", "summary"].iter().all(|key| js::truthy(entry.get(*key))))
        .collect();
    let arcs_source = match field(concept, "story_arcs") {
        Some(Value::Array(items)) => items.as_slice(),
        _ => array(field(concept, "storyArcs")),
    };
    let story_arcs: Vec<Value> = arcs_source
        .iter()
        .take(4)
        .map(|entry| {
            json!({
                "title": clean(field(Some(entry), "title"), 160),
                "levels": clean(field(Some(entry), "levels"), 40),
                "summary": clean(field(Some(entry), "summary"), 520),
                "stakes": clean(field(Some(entry), "stakes"), 360),
            })
        })
        .filter(|entry| js::truthy(entry.get("title")) && js::truthy(entry.get("summary")))
        .collect();
    let text_of = |keys: &[&str], maximum: usize| -> Value {
        let values: Vec<Option<&Value>> = keys.iter().map(|key| field(concept, key)).collect();
        Value::String(clean(coalesce(&values), maximum))
    };
    let mut result = Map::new();
    result.insert("preset".into(), text_of(&["preset"], 160));
    if campaign_mode_for(state) == "persistent" {
        result.insert("campaign_mode".into(), Value::from("persistent"));
        result.insert("quests_optional".into(), Value::Bool(true));
        result.insert("wait_for_player_after_story".into(), Value::Bool(true));
        let stories: Vec<Value> = last_n(array(field(concept, "story_history")), 3)
            .iter()
            .map(|story| {
                json!({
                    "story_id": clean(field(Some(story), "story_id"), 120),
                    "title": clean(field(Some(story), "title"), 180),
                    "outcome": clean(field(Some(story), "outcome"), 30),
                    "summary": clean(field(Some(story), "summary"), 600),
                })
            })
            .collect();
        result.insert("completed_stories".into(), Value::Array(stories));
    }
    for (key, sources, maximum) in [
        ("era", &["era"][..], 80),
        ("genre", &["genre"][..], 100),
        ("tone", &["tone"][..], 160),
        ("premise", &["premise"][..], 400),
        ("themes", &["themes", "theme"][..], 240),
        ("boundaries", &["boundaries"][..], 500),
        ("magic_level", &["magicLevel", "magic_level"][..], 80),
        ("technology_level", &["technologyLevel", "technology_level"][..], 80),
        ("world_template_id", &["world_template_id", "worldTemplateId"][..], 80),
        ("world_template_version", &["world_template_version", "worldTemplateVersion"][..], 40),
        ("world_summary", &["worldSummary", "world_summary"][..], 1_200),
        ("world_history", &["worldHistory", "world_history"][..], 3_000),
    ] {
        result.insert(key.into(), text_of(sources, maximum));
    }
    result.insert("factions".into(), Value::Array(factions));
    result.insert("story_arcs".into(), Value::Array(story_arcs));
    result.insert("current_arc_number".into(), positive_integer(path(concept, &["arc", "arc_number"])));
    result.insert("current_chapter".into(), positive_integer(path(Some(&visible), &["adventure", "chapter"])));
    result.insert("arc_history".into(), Value::Array(arc_history));
    Value::Object(result)
}

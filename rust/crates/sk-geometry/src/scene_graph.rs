//! Перенос `server/scene-graph.mjs` — стадия 1 генератора сцены, граф зон
//! (`docs/tactical-map-plan.md`, раздел 8).
//!
//! Из рецепта сцены строится граф: зоны, связи, двери, где лежат ключи, где
//! вход и цель. Проверка достижимости и порядка получения ключей делается
//! здесь, до всякой геометрии: запертая дверь, ключ от которой лежит за ней
//! же, отсекается на графе, а не поиском по готовой карте. Модуль ничего не
//! знает ни о клетках, ни о карте — только топология.
//!
//! Граф — типизированные структуры; их JSON (`serde`) совпадает с объектами
//! JS: `entranceZoneId`, `goalZoneId`, `keyId: null`, `keysGained`.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sk_core::indexmap::IndexSet;

use crate::js_extra::{js_string, js_trim, slice_utf16};

/// `SCENE_GRAPH_VERSION`.
pub const SCENE_GRAPH_VERSION: &str = "skazanie:scene-graph-v1";

/// `LINK_KINDS` — как связаны две зоны.
pub const LINK_KINDS: [&str; 5] = ["open", "door", "locked", "secret", "oneway"];

/// `SceneGraphError` — отказ построения графа с кодом, как в JS.
///
/// Код `TYPE_ERROR` — то место, где JS падает `TypeError` (рецепт `null`
/// вместо объекта); сообщение повторяет текст V8.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SceneGraphError {
    pub code: String,
    pub message: String,
}

impl SceneGraphError {
    fn new(message: &str, code: &str) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

/// Зона сцены.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneZone {
    pub id: String,
    /// `interior` | `exterior`.
    pub kind: String,
    /// Обязана ли зона быть достижимой.
    pub required: bool,
    /// Идентификаторы ключей, лежащих в этой зоне.
    pub keys: Vec<String>,
    pub label: String,
}

/// Связь двух зон.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneLink {
    pub id: String,
    pub from: String,
    pub to: String,
    /// Значение из [`LINK_KINDS`].
    pub kind: String,
    /// Для `locked` — чем открывается; `null` в JSON, если не задано.
    pub key_id: Option<String>,
    pub bidirectional: bool,
}

/// Граф сцены.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneGraph {
    pub version: String,
    pub zones: Vec<SceneZone>,
    pub links: Vec<SceneLink>,
    /// Откуда входит отряд.
    pub entrance_zone_id: String,
    /// Где цель сцены.
    pub goal_zone_id: String,
}

/// Замечание проверки графа; `at` в JSON опускается, если пусто.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphIssue {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

/// Итог [`validate_scene_graph`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphReport {
    pub ok: bool,
    pub errors: Vec<GraphIssue>,
}

/// Итог [`reachable_zones`]; множества — в порядке вставки, как `Set` в JS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reachability {
    pub zones: IndexSet<String>,
    pub keys: IndexSet<String>,
    pub rounds: i64,
}

/// Волна [`progression_waves`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressionWave {
    pub wave: i64,
    pub zones: Vec<String>,
    pub keys_gained: Vec<String>,
}

/// `text(value, 120)`: строка без пробелов по краям, не длиннее 120 единиц
/// UTF-16; не строка — пустая строка.
fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(raw)) => slice_utf16(js_trim(raw), 120),
        _ => String::new(),
    }
}

fn field<'a>(raw: Option<&'a Value>, name: &str) -> Option<&'a Value> {
    raw.and_then(Value::as_object).and_then(|map| map.get(name))
}

/// `createSceneGraph(input)` — граф из рецепта `{ entranceZoneId, goalZoneId,
/// zones, links }`. Зоны и связи добавляются по очереди и могут отказать с
/// кодом `ZONE_ID_REQUIRED` / `LINK_ENDS_REQUIRED`.
pub fn create_scene_graph(input: &Value) -> Result<SceneGraph, SceneGraphError> {
    if input.is_null() {
        return Err(SceneGraphError::new("Cannot read properties of null (reading 'entranceZoneId')", "TYPE_ERROR"));
    }
    let raw = Some(input);
    let mut graph = SceneGraph {
        version: SCENE_GRAPH_VERSION.into(),
        zones: Vec::new(),
        links: Vec::new(),
        entrance_zone_id: text(field(raw, "entranceZoneId")),
        goal_zone_id: text(field(raw, "goalZoneId")),
    };
    if let Some(Value::Array(zones)) = field(raw, "zones") {
        for zone in zones {
            add_scene_zone(&mut graph, zone)?;
        }
    }
    if let Some(Value::Array(links)) = field(raw, "links") {
        for link in links {
            add_scene_link(&mut graph, link)?;
        }
    }
    Ok(graph)
}

/// `addSceneZone(graph, zone)` — добавить зону и вернуть ссылку на запись в
/// графе (в JS — тот же объект).
pub fn add_scene_zone<'a>(graph: &'a mut SceneGraph, zone: &Value) -> Result<&'a mut SceneZone, SceneGraphError> {
    let raw = Some(zone);
    let id = text(field(raw, "id"));
    if id.is_empty() {
        return Err(SceneGraphError::new("У зоны должен быть идентификатор", "ZONE_ID_REQUIRED"));
    }
    let mut keys: IndexSet<String> = IndexSet::new();
    if let Some(Value::Array(items)) = field(raw, "keys") {
        for key in items {
            let key = text(Some(key));
            if !key.is_empty() {
                keys.insert(key);
            }
        }
    }
    graph.zones.push(SceneZone {
        id,
        kind: if field(raw, "kind").and_then(Value::as_str) == Some("exterior") { "exterior" } else { "interior" }.into(),
        required: matches!(field(raw, "required"), Some(Value::Bool(true))),
        keys: keys.into_iter().collect(),
        label: text(field(raw, "label")),
    });
    let index = graph.zones.len() - 1;
    Ok(&mut graph.zones[index])
}

/// `addSceneLink(graph, link)` — добавить связь. Неизвестный вид становится
/// `open`, односторонний проход всегда не двусторонний, остальные — да,
/// если явно не сказано `bidirectional: false`.
pub fn add_scene_link<'a>(graph: &'a mut SceneGraph, link: &Value) -> Result<&'a mut SceneLink, SceneGraphError> {
    let raw = Some(link);
    let raw_kind = js_string(field(raw, "kind"));
    let kind = if LINK_KINDS.contains(&raw_kind.as_str()) { raw_kind } else { "open".into() };
    let from = text(field(raw, "from"));
    let to = text(field(raw, "to"));
    let id = match text(field(raw, "id")) {
        id if !id.is_empty() => id,
        _ => format!("{from}->{to}"),
    };
    let key_id = match field(raw, "keyId") {
        None | Some(Value::Null) => None,
        value => Some(text(value)),
    };
    let bidirectional = kind != "oneway" && !matches!(field(raw, "bidirectional"), Some(Value::Bool(false)));
    if from.is_empty() || to.is_empty() {
        return Err(SceneGraphError::new("У связи должны быть обе стороны", "LINK_ENDS_REQUIRED"));
    }
    graph.links.push(SceneLink { id, from, to, kind, key_id, bidirectional });
    let index = graph.links.len() - 1;
    Ok(&mut graph.links[index])
}

/// Проходима ли связь при имеющемся наборе ключей. Секретный проход не
/// запирает путь: он лишь не виден, пока не найден.
fn link_passable(link: &SceneLink, keys: &IndexSet<String>) -> bool {
    if link.kind == "locked" {
        return link.key_id.as_ref().is_some_and(|key| keys.contains(key));
    }
    true
}

/// Зоны по идентификатору; при повторе побеждает последняя, как `new Map`.
fn zones_by_id(graph: &SceneGraph) -> HashMap<&str, &SceneZone> {
    let mut by_id = HashMap::new();
    for zone in &graph.zones {
        by_id.insert(zone.id.as_str(), zone);
    }
    by_id
}

/// Соседняя зона по связи из `current`: `from → to`, а для двусторонней —
/// и обратно.
fn link_neighbour<'a>(link: &'a SceneLink, current: &str) -> Option<&'a str> {
    if link.from == current {
        Some(link.to.as_str())
    } else if link.bidirectional && link.to == current {
        Some(link.from.as_str())
    } else {
        None
    }
}

/// `reachableZones(graph, fromZoneId)` — достижимость с учётом ключей:
/// набор ключей растёт по мере продвижения, и обход повторяется, пока набор
/// растёт. По умолчанию (`None` или пусто) — от входа.
pub fn reachable_zones(graph: &SceneGraph, from_zone_id: Option<&str>) -> Reachability {
    let requested = from_zone_id.map(|id| slice_utf16(js_trim(id), 120)).unwrap_or_default();
    let start = if requested.is_empty() { graph.entrance_zone_id.clone() } else { requested };
    let mut zones: IndexSet<String> = IndexSet::new();
    let mut keys: IndexSet<String> = IndexSet::new();
    let by_id = zones_by_id(graph);
    if !by_id.contains_key(start.as_str()) {
        return Reachability { zones, keys, rounds: 0 };
    }

    let mut rounds: i64 = 0;
    let mut grew = true;
    while grew {
        grew = false;
        rounds += 1;
        zones.insert(start.clone());
        // Повторный обход раскрывает заново все уже достигнутые зоны, а не
        // только вход (как JS после исправления): иначе дверь, проверенная до
        // находки ключа, оставалась закрытой. Вход вставлен первым.
        let mut queue: Vec<String> = zones.iter().cloned().collect();
        for key in by_id.get(start.as_str()).map(|zone| zone.keys.as_slice()).unwrap_or_default() {
            if keys.insert(key.clone()) {
                grew = true;
            }
        }
        let mut index = 0;
        while index < queue.len() {
            let current = queue[index].clone();
            index += 1;
            for link in &graph.links {
                let Some(next) = link_neighbour(link, &current) else { continue };
                if next.is_empty() || !by_id.contains_key(next) || zones.contains(next) {
                    continue;
                }
                if !link_passable(link, &keys) {
                    continue;
                }
                zones.insert(next.to_string());
                queue.push(next.to_string());
                grew = true;
                for key in by_id.get(next).map(|zone| zone.keys.as_slice()).unwrap_or_default() {
                    if keys.insert(key.clone()) {
                        grew = true;
                    }
                }
            }
        }
        // Защита от бесконечного цикла: больше зон, чем есть, набрать нельзя.
        if rounds > graph.zones.len() as i64 + 2 {
            break;
        }
    }
    Reachability { zones, keys, rounds }
}

/// `validateSceneGraph(graph)` — список замечаний, а не исключение: при
/// отказе план требует ослабить требования и повторить, а не останавливать
/// игру.
pub fn validate_scene_graph(graph: &SceneGraph) -> GraphReport {
    let mut errors: Vec<GraphIssue> = Vec::new();
    let mut fail = |code: &str, message: String, at: &str| {
        errors.push(GraphIssue { code: code.into(), message, at: (!at.is_empty()).then(|| at.to_string()) });
    };

    let mut by_id: HashSet<&str> = HashSet::new();
    for zone in &graph.zones {
        if by_id.contains(zone.id.as_str()) {
            fail("ZONE_ID_NOT_UNIQUE", format!("Зона {} объявлена дважды", zone.id), &zone.id);
        }
        by_id.insert(zone.id.as_str());
    }
    for link in &graph.links {
        if !by_id.contains(link.from.as_str()) {
            fail("LINK_END_MISSING", format!("Связь {} начинается в несуществующей зоне {}", link.id, link.from), &link.id);
        }
        if !by_id.contains(link.to.as_str()) {
            fail("LINK_END_MISSING", format!("Связь {} ведёт в несуществующую зону {}", link.id, link.to), &link.id);
        }
        if link.kind == "locked" && link.key_id.as_deref().unwrap_or("").is_empty() {
            fail("LOCKED_LINK_WITHOUT_KEY", format!("Запертая связь {} не указывает, чем открывается", link.id), &link.id);
        }
    }
    if !by_id.contains(graph.entrance_zone_id.as_str()) {
        fail("ENTRANCE_ZONE_MISSING", "Зона входа не объявлена".into(), &graph.entrance_zone_id);
    }
    if !graph.goal_zone_id.is_empty() && !by_id.contains(graph.goal_zone_id.as_str()) {
        fail("GOAL_ZONE_MISSING", "Зона цели не объявлена".into(), &graph.goal_zone_id);
    }

    // Все объявленные ключи обязаны где-то лежать, иначе запертая дверь не
    // откроется никогда.
    let placed_keys: HashSet<&str> = graph.zones.iter().flat_map(|zone| zone.keys.iter().map(String::as_str)).collect();
    for link in &graph.links {
        if let Some(key_id) = link.key_id.as_deref().filter(|key| !key.is_empty()) {
            if link.kind == "locked" && !placed_keys.contains(key_id) {
                fail("KEY_NEVER_PLACED", format!("Ключ {} от связи {} нигде не лежит", key_id, link.id), &link.id);
            }
        }
    }

    let reached = reachable_zones(graph, None);
    if !graph.goal_zone_id.is_empty() && by_id.contains(graph.goal_zone_id.as_str()) && !reached.zones.contains(&graph.goal_zone_id) {
        fail("GOAL_UNREACHABLE", "От входа нет пути к цели с учётом дверей и ключей".into(), &graph.goal_zone_id);
    }
    for zone in &graph.zones {
        if zone.required && !reached.zones.contains(&zone.id) {
            fail("REQUIRED_ZONE_UNREACHABLE", format!("Обязательная зона {} недостижима", zone.id), &zone.id);
        }
    }

    // Ключ за собственной дверью: цель может быть достижима в обход, а ключ
    // всё равно заперт сам за собой — тупик для игрока на запертой ветке.
    for link in &graph.links {
        let Some(key_id) = link.key_id.as_deref().filter(|key| !key.is_empty()) else { continue };
        if link.kind != "locked" {
            continue;
        }
        if reached.keys.contains(key_id) {
            continue;
        }
        let holders: Vec<&str> =
            graph.zones.iter().filter(|zone| zone.keys.iter().any(|key| key == key_id)).map(|zone| zone.id.as_str()).collect();
        if holders.is_empty() {
            continue;
        }
        let without_this_door = SceneGraph {
            links: graph.links.iter().filter(|entry| entry.id != link.id).cloned().collect(),
            ..graph.clone()
        };
        let beyond = reachable_zones(&without_this_door, None);
        let only_behind = holders.iter().all(|holder| !beyond.zones.contains(*holder));
        if only_behind {
            fail(
                "KEY_BEHIND_ITS_OWN_DOOR",
                format!("Ключ {} лежит за дверью {}, которую сам и открывает", key_id, link.id),
                &link.id,
            );
        } else {
            fail("KEY_UNREACHABLE", format!("Ключ {} от двери {} недостижим", key_id, link.id), &link.id);
        }
    }

    GraphReport { ok: errors.is_empty(), errors }
}

/// `progressionWaves(graph)` — порядок, в котором зоны становятся доступны.
/// Нужен расстановке: ключ лежит не дальше волны, на которой он пригодится, а
/// цель — в последней.
pub fn progression_waves(graph: &SceneGraph) -> Vec<ProgressionWave> {
    let by_id = zones_by_id(graph);
    let mut seen: IndexSet<String> = IndexSet::new();
    let mut keys: IndexSet<String> = IndexSet::new();
    let mut waves = Vec::new();
    if !by_id.contains_key(graph.entrance_zone_id.as_str()) {
        return waves;
    }

    let mut frontier: Vec<String> = vec![graph.entrance_zone_id.clone()];
    let mut wave: i64 = 0;
    while !frontier.is_empty() {
        let mut gained = Vec::new();
        for id in &frontier {
            seen.insert(id.clone());
            for key in by_id.get(id.as_str()).map(|zone| zone.keys.as_slice()).unwrap_or_default() {
                if keys.insert(key.clone()) {
                    gained.push(key.clone());
                }
            }
        }
        waves.push(ProgressionWave { wave, zones: frontier.clone(), keys_gained: gained });
        let mut next: IndexSet<String> = IndexSet::new();
        for id in &seen {
            for link in &graph.links {
                let Some(candidate) = link_neighbour(link, id) else { continue };
                if candidate.is_empty() || seen.contains(candidate) || !by_id.contains_key(candidate) {
                    continue;
                }
                if !link_passable(link, &keys) {
                    continue;
                }
                next.insert(candidate.to_string());
            }
        }
        frontier = next.into_iter().collect();
        wave += 1;
        if wave > graph.zones.len() as i64 + 2 {
            break;
        }
    }
    waves
}

/// Перенос `test/scene-graph.test.mjs`.
#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    fn graph(input: Value) -> SceneGraph {
        create_scene_graph(&input).expect("граф собирается")
    }

    /// Двор → зал → кладовая за запертой дверью, ключ в кухне.
    fn tavern_graph() -> SceneGraph {
        graph(json!({
            "entranceZoneId": "yard",
            "goalZoneId": "store",
            "zones": [
                { "id": "yard", "kind": "exterior", "label": "Участок" },
                { "id": "hall", "kind": "interior", "required": true, "label": "Общий зал" },
                { "id": "kitchen", "kind": "interior", "keys": ["store-key"], "label": "Кухня" },
                { "id": "store", "kind": "interior", "label": "Кладовая" },
            ],
            "links": [
                { "id": "front", "from": "yard", "to": "hall", "kind": "door" },
                { "id": "to-kitchen", "from": "hall", "to": "kitchen", "kind": "open" },
                { "id": "to-store", "from": "hall", "to": "store", "kind": "locked", "keyId": "store-key" },
            ],
        }))
    }

    fn codes(report: &GraphReport) -> Vec<&str> {
        report.errors.iter().map(|issue| issue.code.as_str()).collect()
    }

    fn sorted(set: &IndexSet<String>) -> Vec<String> {
        let mut items: Vec<String> = set.iter().cloned().collect();
        items.sort();
        items
    }

    #[test]
    fn healthy_graph_passes() {
        let report = validate_scene_graph(&tavern_graph());
        assert_eq!(report.errors, []);
        assert!(report.ok);
    }

    #[test]
    fn key_is_collected_and_reachability_shows_it() {
        let reached = reachable_zones(&tavern_graph(), None);
        assert_eq!(sorted(&reached.zones), ["hall", "kitchen", "store", "yard"]);
        assert_eq!(reached.keys.iter().collect::<Vec<_>>(), ["store-key"]);
        assert!(reached.rounds >= 2, "кладовая открывается только после ключа");
    }

    /// Запертая связь объявлена раньше связи к ключу: ключ находится уже после
    /// проверки двери, и следующий обход обязан раскрыть зал заново.
    #[test]
    fn key_found_after_door_check_opens_it_next_round() {
        let graph = graph(json!({
            "entranceZoneId": "yard",
            "goalZoneId": "store",
            "zones": [
                { "id": "yard", "kind": "exterior", "label": "Участок" },
                { "id": "hall", "kind": "interior", "required": true, "label": "Общий зал" },
                { "id": "kitchen", "kind": "interior", "keys": ["store-key"], "label": "Кухня" },
                { "id": "store", "kind": "interior", "label": "Кладовая" },
            ],
            "links": [
                { "id": "front", "from": "yard", "to": "hall", "kind": "door" },
                { "id": "to-store", "from": "hall", "to": "store", "kind": "locked", "keyId": "store-key" },
                { "id": "to-kitchen", "from": "hall", "to": "kitchen", "kind": "open" },
            ],
        }));
        assert!(reachable_zones(&graph, None).zones.contains("store"));
        assert_eq!(validate_scene_graph(&graph).errors, []);
    }

    #[test]
    fn waves_show_where_key_lies_and_when_goal_opens() {
        let waves = progression_waves(&tavern_graph());
        assert_eq!(waves[0].zones, ["yard"]);
        assert_eq!(waves[1].zones, ["hall"]);
        assert_eq!(waves[2].zones, ["kitchen"]);
        assert_eq!(waves[2].keys_gained, ["store-key"]);
        assert_eq!(waves[3].zones, ["store"], "цель открывается только после того, как найден ключ");
    }

    #[test]
    fn key_behind_its_own_door_is_rejected() {
        let report = validate_scene_graph(&graph(json!({
            "entranceZoneId": "yard",
            "goalZoneId": "store",
            "zones": [{ "id": "yard", "kind": "exterior" }, { "id": "hall", "kind": "interior" }, { "id": "store", "kind": "interior", "keys": ["store-key"] }],
            "links": [
                { "id": "front", "from": "yard", "to": "hall", "kind": "door" },
                { "id": "to-store", "from": "hall", "to": "store", "kind": "locked", "keyId": "store-key" },
            ],
        })));
        assert!(!report.ok);
        assert!(codes(&report).contains(&"KEY_BEHIND_ITS_OWN_DOOR"), "коды: {:?}", codes(&report));
        assert!(codes(&report).contains(&"GOAL_UNREACHABLE"));
    }

    #[test]
    fn goal_behind_locked_door_without_key_is_rejected() {
        let mut graph = tavern_graph();
        graph.zones.iter_mut().find(|zone| zone.id == "kitchen").expect("кухня").keys.clear();
        let report = validate_scene_graph(&graph);
        assert!(!report.ok);
        assert!(codes(&report).contains(&"KEY_NEVER_PLACED"));
        assert!(codes(&report).contains(&"GOAL_UNREACHABLE"));
    }

    #[test]
    fn unreachable_required_zone_is_rejected() {
        let mut graph = tavern_graph();
        let added = add_scene_zone(&mut graph, &json!({ "id": "cellar", "kind": "interior", "required": true, "label": "Подвал" }))
            .expect("зона добавлена");
        assert_eq!(added.label, "Подвал");
        let report = validate_scene_graph(&graph);
        assert!(!report.ok);
        assert!(report.errors.iter().any(|issue| issue.code == "REQUIRED_ZONE_UNREACHABLE" && issue.at.as_deref() == Some("cellar")));
    }

    #[test]
    fn locked_link_without_key_and_dangling_link_are_rejected() {
        let mut graph = tavern_graph();
        add_scene_link(&mut graph, &json!({ "id": "broken-lock", "from": "hall", "to": "kitchen", "kind": "locked" })).expect("связь");
        add_scene_link(&mut graph, &json!({ "id": "dangling", "from": "hall", "to": "nowhere", "kind": "open" })).expect("связь");
        let report = validate_scene_graph(&graph);
        assert!(codes(&report).contains(&"LOCKED_LINK_WITHOUT_KEY"));
        assert!(codes(&report).contains(&"LINK_END_MISSING"));
    }

    #[test]
    fn one_way_passage_does_not_lead_back() {
        let graph = graph(json!({
            "entranceZoneId": "ledge",
            "goalZoneId": "pit",
            "zones": [{ "id": "ledge", "kind": "exterior" }, { "id": "pit", "kind": "interior" }],
            "links": [{ "id": "drop", "from": "ledge", "to": "pit", "kind": "oneway" }],
        }));
        assert_eq!(sorted(&reachable_zones(&graph, None).zones), ["ledge", "pit"]);
        assert_eq!(reachable_zones(&graph, Some("pit")).zones.iter().collect::<Vec<_>>(), ["pit"], "из ямы обратно хода нет");
        assert!(validate_scene_graph(&graph).ok);
    }

    #[test]
    fn chain_of_three_keys_is_solved_in_order() {
        let graph = graph(json!({
            "entranceZoneId": "a",
            "goalZoneId": "d",
            "zones": [{ "id": "a", "keys": ["k1"] }, { "id": "b", "keys": ["k2"] }, { "id": "c", "keys": ["k3"] }, { "id": "d" }],
            "links": [
                { "id": "ab", "from": "a", "to": "b", "kind": "locked", "keyId": "k1" },
                { "id": "bc", "from": "b", "to": "c", "kind": "locked", "keyId": "k2" },
                { "id": "cd", "from": "c", "to": "d", "kind": "locked", "keyId": "k3" },
            ],
        }));
        assert_eq!(validate_scene_graph(&graph).errors, []);
        let waves = progression_waves(&graph);
        assert_eq!(waves.iter().map(|wave| wave.zones.clone()).collect::<Vec<_>>(), [["a"], ["b"], ["c"], ["d"]]);
        let gained: Vec<Vec<String>> = waves.iter().map(|wave| wave.keys_gained.clone()).collect();
        assert_eq!(gained, [vec!["k1".to_string()], vec!["k2".into()], vec!["k3".into()], vec![]]);
    }

    #[test]
    fn swapped_key_order_is_caught() {
        let report = validate_scene_graph(&graph(json!({
            "entranceZoneId": "a",
            "goalZoneId": "c",
            "zones": [{ "id": "a", "keys": ["k1"] }, { "id": "b" }, { "id": "c", "keys": ["k2"] }],
            "links": [
                { "id": "ab", "from": "a", "to": "b", "kind": "locked", "keyId": "k1" },
                { "id": "bc", "from": "b", "to": "c", "kind": "locked", "keyId": "k2" },
            ],
        })));
        assert!(!report.ok);
        assert!(report.errors.iter().any(|issue| issue.code == "KEY_BEHIND_ITS_OWN_DOOR" && issue.at.as_deref() == Some("bc")));
    }

    #[test]
    fn zone_without_id_and_link_without_end_are_refused() {
        let mut graph = graph(json!({ "entranceZoneId": "a", "zones": [{ "id": "a" }] }));
        let zone_error = add_scene_zone(&mut graph, &json!({ "kind": "interior" })).expect_err("зона без id");
        assert_eq!(zone_error.code, "ZONE_ID_REQUIRED");
        let link_error = add_scene_link(&mut graph, &json!({ "from": "a", "kind": "open" })).expect_err("связь без конца");
        assert_eq!(link_error.code, "LINK_ENDS_REQUIRED");
        assert_eq!(graph.zones.len(), 1);
        assert!(graph.links.is_empty());
    }

    #[test]
    fn graph_without_entrance_gets_clear_refusal() {
        let report = validate_scene_graph(&graph(json!({ "zones": [{ "id": "a" }], "goalZoneId": "a" })));
        assert!(!report.ok);
        assert!(codes(&report).contains(&"ENTRANCE_ZONE_MISSING"));
        // Пустой `at` в JSON не пишется, как в JS.
        let entrance = report.errors.iter().find(|issue| issue.code == "ENTRANCE_ZONE_MISSING").expect("замечание");
        assert_eq!(serde_json::to_value(entrance).expect("JSON"), json!({ "code": "ENTRANCE_ZONE_MISSING", "message": "Зона входа не объявлена" }));
    }

    #[test]
    fn secret_passage_does_not_lock_the_way() {
        let report = validate_scene_graph(&graph(json!({
            "entranceZoneId": "hall",
            "goalZoneId": "vault",
            "zones": [{ "id": "hall" }, { "id": "vault", "required": true }],
            "links": [{ "id": "hidden", "from": "hall", "to": "vault", "kind": "secret" }],
        })));
        assert_eq!(report.errors, [], "секрет — это видимость, а не замок");
    }

    #[test]
    fn null_recipe_is_type_error_like_js() {
        let error = create_scene_graph(&Value::Null).expect_err("JS падает TypeError");
        assert_eq!(error.code, "TYPE_ERROR");
        assert_eq!(error.message, "Cannot read properties of null (reading 'entranceZoneId')");
        assert_eq!(create_scene_graph(&json!({})).expect("пустой граф").version, SCENE_GRAPH_VERSION);
    }

    /// Замечено в JS и перенесено как есть: повторный обход начинается от входа
    /// и не проходит через уже достигнутые зоны, поэтому ключ, найденный в
    /// том же обходе после проверки запертой двери, эту дверь уже не открывает.
    #[test]
    fn late_key_in_same_round_does_not_reopen_checked_door() {
        let graph = graph(json!({
            "entranceZoneId": "a",
            "goalZoneId": "c",
            "zones": [{ "id": "a" }, { "id": "b" }, { "id": "c" }, { "id": "d", "keys": ["k"] }],
            "links": [
                { "id": "ab", "from": "a", "to": "b", "kind": "open" },
                { "id": "bc", "from": "b", "to": "c", "kind": "locked", "keyId": "k" },
                { "id": "bd", "from": "b", "to": "d", "kind": "open" },
            ],
        }));
        let reached = reachable_zones(&graph, None);
        assert_eq!(reached.zones.iter().collect::<Vec<_>>(), ["a", "b", "d"]);
        assert_eq!(reached.rounds, 2);
        assert_eq!(codes(&validate_scene_graph(&graph)), ["GOAL_UNREACHABLE"]);
        // Волны прогрессии ту же дверь открывают.
        assert_eq!(progression_waves(&graph).last().expect("волна").zones, ["c"]);
    }
}

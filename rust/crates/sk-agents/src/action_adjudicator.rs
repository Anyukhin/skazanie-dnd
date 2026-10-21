//! Перенос `server/action-adjudicator.mjs`: арбитр свободного действия.
//! Единственная роль модели здесь — **понять задумку**: какой характеристикой
//! и навыком её судить, насколько она вообще возможна, чем игрок рискует и чего
//! это стоит в бою; и назвать маршрут заявки (`check`/`travel`/`talk`/`clarify`).
//!
//! Модель не бросает кубики, не выбирает СЛ, не описывает исход и не может
//! назначить эффект вне закрытого списка. Всё, что она вернула, проходит через
//! [`normalize_free_action_reading`] и каталог `improvised-effects`; при любой
//! ошибке, таймауте или отсутствии клиента предложение молча заменяется
//! детерминированным прочтением.
//!
//! Клиент модели внедряется ([`LlmClient`]); промпт —
//! `prompts/action_adjudicator/v10.txt`, встроен при сборке.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_agents_base::llm_client::LlmClient;
use sk_attention::improvised_effects::{scene_prop_intent_for, ENVIRONMENT_HAZARD_IDS, IMPROVISED_EFFECT_IDS};
use sk_combat_content::combat_spells::canonical_combat_spell_for;
use sk_combat_content::scene_hazards::{hazard_prop_cells, ignite_definition_for, scene_hazard_verbs_for, topple_definition_for};
use sk_core::indexmap::IndexSet;
use sk_core::{js, re, text};
use sk_encounters::agent_context::{agent_context_metadata, bounded_selection_metadata, scene_canon_for, AgentContextOptions, SelectionOptions};
use sk_geometry::actor_footprint::footprint_distance_feet;
use sk_projection::viewer_projection::campaign_state_for_viewer;
use sk_social::npc_social::npc_social_for_viewer;
use sk_tactical::scene_interactions::scene_interaction_catalog_entry;
use sk_tactical::tactical_map::{cell_at, deserialize_tactical_map, TacticalMap};
use sk_tactics::security::build_data_only_context;

use crate::free_action_adjudication::{
    bind_free_action_reading_to_state, contextual_resolution_for, d20_check_label, explain_action_check, harmless_free_action_reading, has_recognized_free_action_approach,
    interpret_free_action, normalize_free_action_reading, resolve_exploration_command, resolve_hazard_contact, verify_means, FreeActionResult, FREE_ACTION_ACTIVITY_KINDS,
    FREE_ACTION_CONSEQUENCE_TYPES, FREE_ACTION_DURATION_CLASSES, FREE_ACTION_PROFICIENCY_LEVELS, FREE_ACTION_SKILLS, PLAUSIBILITY_LEVELS, RISK_LEVELS,
};

/// `prompts/action_adjudicator/v10.txt`.
pub const ACTION_ADJUDICATOR_PROMPT: &str = include_str!("../../../../prompts/action_adjudicator/v10.txt");

/// Версия контракта: она же попадает в метаданные контекста и трассу.
pub const ACTION_ADJUDICATOR_PROMPT_VERSION: &str = "action_adjudicator/v10";

/// Срок ответа по умолчанию (`timeoutMs = 12_000`).
pub const ACTION_ADJUDICATOR_DEFAULT_TIMEOUT_MS: i64 = 12_000;

/// Куда на самом деле ведёт заявка, которую не узнал детерминированный слой.
pub const FREE_ACTION_ROUTES: [&str; 4] = ["check", "travel", "talk", "clarify"];

const FREE_ACTION_RESPONSE_FIELDS: [&str; 25] = [
    "goal_summary", "approach_summary", "obstacle", "activity_kind", "duration_class",
    "ability", "skill", "plausibility", "risk", "required_means", "action_cost",
    "effect", "effect_target", "hazard", "prop_id", "target_id", "item_id",
    "proficiency", "consequence_type",
    "route", "destination", "npc_hint",
    "success_detail", "surface_detail", "failure_detail",
];

const ABILITIES: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];
const ACTION_COSTS: [&str; 3] = ["action", "bonus_action", "free"];

// --- приведения -------------------------------------------------------------------

fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn at<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().fold(value, |current, key| prop(current, key))
}

fn arr(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        None | Some(Value::Null) => second,
        some => some,
    }
}

fn is_str(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// `clean(value, maximum = 240)` модуля.
fn clean(value: &str, maximum: usize) -> String {
    text::head(&text::squash_spaces(&text::nfkc(value)), maximum)
}

fn clean_v(value: Option<&Value>, maximum: usize) -> String {
    clean(&js::s(value), maximum)
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `value?.length` как условие: непустой массив или строка.
fn length_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(chars)) => !chars.is_empty(),
        _ => false,
    }
}

fn control_chars() -> &'static sk_core::fancy_regex::Regex {
    re!(r"[\x{0000}-\x{001f}\x{007f}]", "gu")
}

/// `cleanTravelDestination(value)`: пункт назначения — только короткий текст
/// без разметки; кавычки и скобки снимаются.
pub fn clean_travel_destination(value: Option<&Value>) -> String {
    let stripped = text::replace_all(control_chars(), &clean_v(value, 200), "");
    let stripped = text::replace_all(re!(r#"[«»"“”„[\]{}<>]"#, "gu"), &stripped, "");
    let result = text::squash_spaces(&stripped);
    if utf16_len(&result) > 80 || text::find_all(re!(r"\p{L}", "gu"), &result).len() < 2 {
        return String::new();
    }
    result
}

/// Маршрут из ответа модели, сверенный с брифом.
fn route_from_response(result: &Value, participants: &[Value]) -> (String, String, String) {
    let raw = js::s(result.get("route"));
    let route = if FREE_ACTION_ROUTES.contains(&raw.as_str()) { js::string(result.get("route")) } else { "check".into() };
    let npc_ids: HashSet<String> = participants.iter().filter(|entry| is_str(entry.get("side"), "npc")).map(|entry| js::s(entry.get("id"))).collect();
    let destination = if route == "travel" { clean_travel_destination(result.get("destination")) } else { String::new() };
    let hint = js::s(result.get("npc_hint"));
    let npc_hint = if route == "talk" && npc_ids.contains(&hint) { js::string(result.get("npc_hint")) } else { String::new() };
    (route, destination, npc_hint)
}

/// `cleanSuccessDetail(value)`: деталь успеха — одна фраза без разметки и
/// чисел механики; пустая строка — детали нет.
pub fn clean_success_detail(value: Option<&Value>) -> String {
    let stripped = text::replace_all(control_chars(), &clean_v(value, 300), "");
    let stripped = text::replace_all(re!(r"[{}<>[\]]", "gu"), &stripped, "");
    let result = text::trim(&stripped).to_string();
    let length = utf16_len(&result);
    if !(12..=220).contains(&length) {
        return String::new();
    }
    // Числа механики и исход броска — дело сервера, не детали мира.
    if text::test(re!(r"(?<![\p{L}\p{N}])(?:СЛ|КД|d20|к20)(?![\p{L}\p{N}])|(?:хит|урон|бросок|проверк|успех|провал)", "iu"), &result) {
        return String::new();
    }
    if text::test(re!(r"[.!?…»]$", "u"), &result) {
        result
    } else {
        format!("{result}.")
    }
}

fn non_empty_string(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| !text::trim(text).is_empty())
}

fn valid_string_field(value: Option<&Value>, values: &[&str], normalize: fn(&str) -> String) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| values.contains(&normalize(text).as_str()))
}

fn same(value: &str) -> String {
    value.to_string()
}

fn skill_form(value: &str) -> String {
    text::lower(value).replace('_', "-")
}

/// `structurallyValidFreeActionResponse(value)`: ответ модели строго по
/// контракту; лишнее поле или выдуманное значение — ответ сломан.
pub fn structurally_valid_free_action_response(value: &Value) -> bool {
    let Some(map) = value.as_object() else { return false };
    if map.keys().any(|key| !FREE_ACTION_RESPONSE_FIELDS.contains(&key.as_str())) {
        return false;
    }
    if ["goal_summary", "approach_summary", "obstacle"].iter().any(|key| !non_empty_string(map.get(*key))) {
        return false;
    }
    let field = |key: &str| map.get(key);
    if !valid_string_field(field("ability"), &ABILITIES, same)
        || !valid_string_field(field("skill"), &FREE_ACTION_SKILLS, skill_form)
        || !valid_string_field(field("plausibility"), &PLAUSIBILITY_LEVELS, same)
        || !valid_string_field(field("risk"), &RISK_LEVELS, same)
        || !valid_string_field(field("action_cost"), &ACTION_COSTS, same)
        || !valid_string_field(field("effect"), &IMPROVISED_EFFECT_IDS, same)
        || !valid_string_field(field("proficiency"), &FREE_ACTION_PROFICIENCY_LEVELS, same)
        || !valid_string_field(field("consequence_type"), &FREE_ACTION_CONSEQUENCE_TYPES, same)
    {
        return false;
    }
    if map.contains_key("activity_kind") && !valid_string_field(field("activity_kind"), &FREE_ACTION_ACTIVITY_KINDS, same) {
        return false;
    }
    if map.contains_key("duration_class") && !valid_string_field(field("duration_class"), &FREE_ACTION_DURATION_CLASSES, same) {
        return false;
    }
    if let Some(means) = field("required_means") {
        match means {
            Value::Array(items) if items.iter().all(|item| non_empty_string(Some(item))) => {}
            _ => return false,
        }
    }
    for key in ["effect_target", "hazard", "prop_id", "target_id", "item_id"] {
        if map.contains_key(key) && !field(key).is_some_and(Value::is_string) {
            return false;
        }
    }
    if let Some(hazard) = field("hazard").and_then(Value::as_str) {
        if !hazard.is_empty() && !ENVIRONMENT_HAZARD_IDS.contains(&hazard) {
            return false;
        }
    }
    if map.contains_key("route") && !valid_string_field(field("route"), &FREE_ACTION_ROUTES, same) {
        return false;
    }
    for key in ["destination", "npc_hint", "success_detail", "surface_detail", "failure_detail"] {
        if map.contains_key(key) && !field(key).and_then(Value::as_str).is_some_and(|text| utf16_len(text) <= 300) {
            return false;
        }
    }
    true
}

fn players(state: &Value) -> &[Value] {
    arr(prop(Some(state), "players"))
}

fn ruleset_options(state: &Value) -> Value {
    match state.get("ruleset_id") {
        Some(ruleset) => json!({ "rulesetId": ruleset }),
        None => json!({}),
    }
}

fn cleaned_list(value: Option<&Value>, maximum: usize) -> Vec<String> {
    arr(value).iter().map(|entry| clean_v(Some(entry), maximum)).collect()
}

/// Лист героя в том объёме, который нужен для выбора кубика, и не шире.
fn hero_brief(state: &Value, actor_id: &str) -> Value {
    let empty = json!({});
    let hero = players(state).iter().find(|actor| js::string(prop(Some(actor), "id")) == actor_id).unwrap_or(&empty);
    let sheet = nullish(hero.get("characterSheet"), None);
    let inventory = arr(hero.get("inventory"));
    let mut expertise = Vec::new();
    for key in ["skillExpertiseIds", "expertiseSkillIds", "skillExpertise", "expertiseSkills"] {
        expertise.extend(cleaned_list(hero.get(key), 60));
    }
    expertise.truncate(20);
    let mut spell_ids: IndexSet<String> = IndexSet::new();
    let mut unique_spells = Vec::new();
    for id in arr(hero.get("knownSpellIds")).iter().chain(arr(hero.get("preparedSpellIds"))) {
        if spell_ids.insert(js::stringify(id)) {
            unique_spells.push(id);
        }
    }
    let options = ruleset_options(state);
    let spell_names: Vec<String> = unique_spells
        .into_iter()
        .map(|id| clean_v(canonical_combat_spell_for(Some(id), Some(&options)).as_ref().and_then(|spell| spell.get("name")), 80))
        .filter(|name| !name.is_empty())
        .take(24)
        .collect();
    let items: Vec<Value> = inventory
        .iter()
        .take(30)
        .map(|item| json!({ "id": clean_v(prop(Some(item), "id"), 120), "name": clean_v(prop(Some(item), "name"), 80), "equipped": js::is_true(prop(Some(item), "equipped")) }))
        .collect();
    let truncated = inventory.len() > 30;
    let speed = js::number(hero.get("speed"));
    let mut brief = Map::new();
    brief.insert("id".into(), json!(match nullish(hero.get("id"), None) {
        Some(id) => js::string(Some(id)),
        None => actor_id.to_string(),
    }));
    brief.insert("name".into(), json!(clean_v(nullish(hero.get("character"), hero.get("name")), 80)));
    brief.insert("role".into(), json!(clean_v(hero.get("role"), 80)));
    brief.insert("abilities".into(), nullish(prop(sheet, "abilities"), nullish(hero.get("abilities"), None)).cloned().unwrap_or_else(|| json!({})));
    brief.insert("skill_proficiencies".into(), json!(cleaned_list(hero.get("classSkillProficiencies"), 60)));
    brief.insert("skill_expertise".into(), json!(expertise));
    brief.insert("prepared_spells".into(), json!(cleaned_list(hero.get("preparedSpellIds"), 60).into_iter().take(20).collect::<Vec<_>>()));
    brief.insert("known_spells".into(), json!(cleaned_list(hero.get("knownSpellIds"), 60).into_iter().take(20).collect::<Vec<_>>()));
    brief.insert("spell_names".into(), json!(spell_names));
    brief.insert("features".into(), json!(cleaned_list(hero.get("selectedFeatureIds"), 60).into_iter().take(20).collect::<Vec<_>>()));
    brief.insert("inventory".into(), Value::Array(items));
    brief.insert("inventory_scope".into(), json!("items_owned_by_active_hero"));
    brief.insert("inventory_status".into(), json!(if truncated { "truncated" } else if inventory.is_empty() { "empty" } else { "complete" }));
    brief.insert("inventory_availability".into(), json!("available"));
    brief.insert("inventory_complete_within_scope".into(), json!(!truncated));
    if truncated {
        brief.insert("inventory_truncation_reason".into(), json!("item_limit"));
    }
    brief.insert("speed".into(), js::num(if speed.is_nan() || speed == 0.0 { 30.0 } else { speed }));
    Value::Object(brief)
}

fn position_of(actor: &Value) -> Value {
    let x = js::number(actor.get("x"));
    if x.is_finite() {
        json!({ "x": js::num(x), "y": js::num(js::number(actor.get("y"))) })
    } else {
        Value::Null
    }
}

fn participant(actor: &Value, side: &str, aliases: Vec<String>) -> Value {
    json!({
        "id": js::string(actor.get("id")),
        "name": clean_v(if side == "party" { nullish(actor.get("character"), actor.get("name")) } else { actor.get("name") }, 80),
        "role": clean_v(actor.get("role"), 80),
        "aliases": aliases,
        "side": side,
        "at": position_of(actor),
    })
}

/// Кто на поле. Без этого модель не может назвать корректный `effect_target`.
fn participant_candidates(state: &Value, actor_id: &str) -> Vec<Value> {
    let location = text::lower(&clean_v(at(Some(state), &["scene", "location"]), 180));
    let viewer = json!({ "state": state, "playerId": actor_id, "isPartyMember": true });
    let social = npc_social_for_viewer(prop(Some(state), "social").unwrap_or(&Value::Null), &viewer);
    let npcs: Vec<&Value> = arr(social.get("npcs"))
        .iter()
        .filter(|actor| {
            let actor_location = text::lower(&clean_v(prop(Some(actor), "location"), 180));
            !js::is_false(prop(Some(actor), "available")) && (location.is_empty() || actor_location.is_empty() || location == actor_location)
        })
        .collect();
    let visible = campaign_state_for_viewer(Some(state), Some(&json!({ "role": "player" })), Some(&Value::String(actor_id.to_string()))).ok().flatten();
    let enemies = arr(visible.as_ref().and_then(|view| view.get("enemies")));
    let mut all: Vec<Value> = Vec::new();
    all.extend(players(state).iter().map(|actor| participant(actor, "party", Vec::new())));
    // Спутники отряда (`state.actors`) — имя без `character`.
    all.extend(arr(prop(Some(state), "actors")).iter().map(|actor| {
        let mut entry = participant(actor, "party", Vec::new());
        entry["name"] = json!(clean_v(actor.get("name"), 80));
        entry
    }));
    all.extend(
        enemies
            .iter()
            .filter(|actor| !js::is_false(prop(Some(actor), "alive")) && js::number(Some(nullish(prop(Some(actor), "hp"), None).unwrap_or(&json!(1)))) > 0.0)
            .map(|actor| participant(actor, "enemy", Vec::new())),
    );
    all.extend(npcs.into_iter().map(|actor| {
        let aliases: Vec<String> = arr(actor.get("tags")).iter().map(|entry| clean_v(Some(entry), 60)).filter(|entry| !entry.is_empty() && !entry.contains(':')).take(8).collect();
        participant(actor, "npc", aliases)
    }));
    let mut seen = HashSet::new();
    all.into_iter().filter(|actor| seen.insert(js::s(actor.get("id")))).collect()
}

fn selection(scope: &str, count: usize, limit: usize) -> Value {
    let scope = json!(scope);
    let count = json!(count);
    let limit = json!(limit);
    bounded_selection_metadata(&SelectionOptions { scope: Some(&scope), candidate_count: Some(&count), limit: Some(&limit), source_available: None })
}

fn unavailable_selection(scope: &str) -> Value {
    let scope = json!(scope);
    let unavailable = json!(false);
    bounded_selection_metadata(&SelectionOptions { scope: Some(&scope), candidate_count: None, limit: None, source_available: Some(&unavailable) })
}

fn participants_brief(state: &Value, actor_id: &str) -> (Vec<Value>, Value) {
    let candidates = participant_candidates(state, actor_id);
    let metadata = selection("visible_living_participants_in_current_scene", candidates.len(), 24);
    (candidates.into_iter().take(24).collect(), metadata)
}

/// Позиция героя так же, как её видит движок: `mechanics.positions` первична.
fn hero_position(state: &Value, actor_id: &str) -> Option<(f64, f64)> {
    let stored = at(Some(state), &["mechanics", "positions"]).and_then(|positions| prop(Some(positions), actor_id));
    let hero = players(state).iter().find(|actor| js::string(prop(Some(actor), "id")) == actor_id);
    let coordinate = |key: &str| js::number(nullish(prop(stored, key), prop(hero, key))).floor();
    let (x, y) = (coordinate("x"), coordinate("y"));
    (x.is_finite() && y.is_finite()).then_some((x, y))
}

/// Раскрытие предмета по авторитетной карте ([`revealed_prop_predicate`]).
pub struct RevealedPropPredicate {
    map: Option<TacticalMap>,
}

impl RevealedPropPredicate {
    /// Виден ли предмет игроку: не скрыт ведущим и стоит на раскрытой клетке.
    pub fn test(&self, prop_value: &Value) -> bool {
        let Some(map) = &self.map else { return false };
        let visibility = text::lower(&js::s(nullish(prop(Some(prop_value), "visibility"), at(Some(prop_value), &["interaction", "visibility"]))));
        visibility != "gm_only"
            && visibility != "npc_private"
            && !js::is_false(prop(Some(prop_value), "revealed"))
            && hazard_prop_cells(Some(prop_value)).iter().any(|cell| {
                let (x, y) = (js::number(cell.get("x")), js::number(cell.get("y")));
                x.fract() == 0.0 && y.fract() == 0.0 && x.is_finite() && y.is_finite() && x.abs() < 9e15 && y.abs() < 9e15 && cell_at(map, x as i64, y as i64).is_some_and(|cell| cell.revealed)
            })
    }
}

/// `revealedPropPredicate(state)`: раскрытие клетки по авторитетной карте —
/// тот же вопрос, что решает проекция зрителя. Карту, которую не разобрать,
/// — ни один предмет не виден.
pub fn revealed_prop_predicate(state: &Value) -> RevealedPropPredicate {
    let map = at(Some(state), &["scene", "map"]).filter(|map| map.is_object() || map.is_array()).and_then(|map| deserialize_tactical_map(map).ok());
    RevealedPropPredicate { map }
}

const SCENE_PROPS_SCOPE: &str = "visible_interactable_objects_in_current_area";

/// Предметы обстановки, с которыми движок действительно умеет работать.
fn scene_props_brief(state: &Value, actor_id: &str) -> (Vec<Value>, Value) {
    let hero_at = hero_position(state, actor_id);
    let hero = players(state).iter().find(|actor| js::string(prop(Some(actor), "id")) == actor_id);
    let Some(serialized) = at(Some(state), &["scene", "map"]).filter(|map| map.is_object() || map.is_array()) else {
        return (Vec::new(), unavailable_selection(SCENE_PROPS_SCOPE));
    };
    if deserialize_tactical_map(serialized).is_err() {
        return (Vec::new(), unavailable_selection(SCENE_PROPS_SCOPE));
    }
    let revealed = revealed_prop_predicate(state);
    let interactions = at(Some(state), &["mechanics", "scene_interactions"]);
    let mut candidates: Vec<(Value, Option<f64>, String)> = Vec::new();
    for entry in arr(serialized.get("props")) {
        let id = clean_v(prop(Some(entry), "id"), 120);
        let asset = prop(Some(entry), "assetId");
        let verbs = scene_hazard_verbs_for(asset);
        if id.is_empty() || verbs.is_empty() || scene_interaction_catalog_entry(asset).is_none() {
            continue;
        }
        if !revealed.test(entry) {
            continue;
        }
        let mass = topple_definition_for(asset).and_then(|definition| definition.get("mass").cloned()).filter(|mass| js::truthy(Some(mass)));
        let name = mass.or_else(|| ignite_definition_for(asset).and_then(|definition| definition.get("what").cloned()).filter(|what| js::truthy(Some(what)))).unwrap_or_else(|| json!(""));
        let cell = hazard_prop_cells(Some(entry)).into_iter().next();
        let interaction_state = prop(interactions, &id).and_then(|record| prop(Some(record), "state"));
        let state_value = if js::truthy(interaction_state) { interaction_state } else { prop(Some(entry), "state") };
        let state_text = clean_v(state_value, 40);
        let distance = match (hero_at, &cell) {
            (Some((x, y)), Some(cell)) => {
                let cells = json!([cell]);
                footprint_distance_feet(hero, Some(&cells), Some(&json!({ "x": js::num(x), "y": js::num(y) })), None)
            }
            _ => None,
        };
        let item = json!({
            "id": id,
            "name": clean_v(Some(&name), 80),
            "state": if state_text.is_empty() { "idle".to_string() } else { state_text },
            "verbs": verbs,
            "at": cell.unwrap_or(Value::Null),
            "distance_feet": distance.map_or(Value::Null, js::num),
        });
        candidates.push((item, distance, id));
    }
    // Ближнее — первым, порядок устойчивый.
    candidates.sort_by(|left, right| {
        let (a, b) = (left.1.unwrap_or(10_000.0), right.1.unwrap_or(10_000.0));
        a.partial_cmp(&b).filter(|order| order.is_ne()).unwrap_or_else(|| text::locale_compare(&left.2, &right.2))
    });
    let metadata = selection(SCENE_PROPS_SCOPE, candidates.len(), 12);
    (candidates.into_iter().take(12).map(|(item, _, _)| item).collect(), metadata)
}

fn insert_selection_fields(target: &mut Map<String, Value>, metadata: &Value, prefix: &str) {
    for key in ["scope", "status", "availability", "complete_within_scope"] {
        if let Some(value) = metadata.get(key) {
            target.insert(format!("{prefix}_{key}"), value.clone());
        }
    }
    if js::truthy(metadata.get("truncation_reason")) {
        target.insert(format!("{prefix}_truncation_reason"), metadata["truncation_reason"].clone());
    }
}

fn economy_brief(state: &Value, actor_id: &str) -> Value {
    let combat = at(Some(state), &["mechanics", "combat"]);
    if !js::truthy(prop(combat, "active")) {
        return json!({ "in_combat": false });
    }
    let economy = prop(prop(combat, "action_economy"), actor_id);
    let round = js::number(prop(combat, "round"));
    let spent = js::number(prop(economy, "movement_spent"));
    json!({
        "in_combat": true,
        "round": js::num(if round.is_nan() || round == 0.0 { 1.0 } else { round }),
        "action_available": !js::is_false(prop(economy, "action")),
        "bonus_action_available": !js::is_false(prop(economy, "bonus_action")),
        "movement_spent_feet": js::num(if spent.is_nan() { 0.0 } else { spent }),
    })
}

fn question_action_text(question: &str) -> String {
    let value = clean(question, 1_000);
    let value = text::replace_first(re!(r"^(?:а\s+если|если|можно\s+ли|могу\s+ли|что\s+если|что\s+будет\s*,?\s*если)\s+(?:(?:мне|я)\s+)?", "iu"), &value, "");
    let value = text::replace_first(re!(r"^открыть\s+", "iu"), &value, "Открываю ");
    let value = text::replace_first(re!(r"^закрыть\s+", "iu"), &value, "Закрываю ");
    let value = text::replace_first(re!(r"^подойти\s+", "iu"), &value, "Подхожу ");
    let value = text::replace_first(re!(r"(?<![\p{L}\p{M}])врежусь(?![\p{L}\p{M}])", "iu"), &value, "врезаюсь");
    text::replace_first(re!(r"[?]+$", "u"), &value, "")
}

fn direct_contact_question(state: &Value, actor_id: &str, value: &str) -> FreeActionResult<Option<Value>> {
    let reading = bind_free_action_reading_to_state(state, actor_id, value, &interpret_free_action(value), false)?;
    if text::test(re!(r"(?<![\p{L}\p{M}])не\s+(?:сяду|сажусь|врежусь|врезаюсь|касаюсь|наступаю|трогаю)(?![\p{L}\p{M}])", "iu"), value) {
        return Ok(Some(json!({
            "reading": reading,
            "narration": "Если герой не касается опасности, этот вопрос не выполняет контакт и не наносит урон. Сейчас это только вопрос.",
        })));
    }
    let Some(contact) = resolve_hazard_contact(state, actor_id, value, &reading) else { return Ok(None) };
    let status = js::s(contact.get("status"));
    if status != "contact" && status != "unavailable" {
        return Ok(None);
    }
    if status == "unavailable" {
        return Ok(Some(json!({ "reading": reading, "narration": format!("{} Сейчас это только вопрос: урон не применяется.", js::string(contact.get("reason"))) })));
    }
    let wall = js::s(at(Some(&contact), &["source", "kind"])).starts_with("wall-");
    let damage = js::s(contact.get("damage_type"));
    let label = match damage.as_str() {
        "fire" => "огненный",
        "bludgeoning" => "дробящий",
        _ => "соответствующий",
    };
    let burn = if damage == "fire" { " Акробатика не отменяет ожог." } else { "" };
    let start = if wall { "При ударе о стену" } else { "При прямом контакте с этой опасностью" };
    Ok(Some(json!({
        "reading": reading,
        "narration": format!("{start} герой получит {label} урон.{burn} Сейчас это только вопрос: действие не выполнено."),
    })))
}

/// `knownSceneDescription(state)`: подтверждённое описание текущего места —
/// пролог кампании о нём и текст прибытия, только общие для отряда факты.
pub fn known_scene_description(state: &Value) -> String {
    let scene = prop(Some(state), "scene");
    let location = text::lower(&clean_v(prop(scene, "location"), 120));
    let memory = prop(Some(state), "worldMemory");
    let location_ids: HashSet<String> = arr(prop(memory, "entities"))
        .iter()
        .filter(|entity| !location.is_empty() && text::lower(&clean_v(prop(Some(entity), "name"), 120)) == location)
        .map(|entity| js::string(prop(Some(entity), "id")))
        .collect();
    let mut parts: Vec<String> = arr(prop(memory, "facts"))
        .iter()
        .filter(|fact| {
            is_str(prop(Some(fact), "predicate"), "opening_narration")
                && is_str(prop(Some(fact), "visibility"), "party")
                && nullish(prop(Some(fact), "status"), None).map_or(true, |status| is_str(Some(status), "active"))
                && location_ids.contains(&js::string(prop(Some(fact), "subject_id")))
        })
        .map(|fact| clean_v(prop(Some(fact), "summary"), 1_000))
        .collect();
    parts.extend([prop(scene, "arrival"), prop(scene, "transition")].into_iter().map(|value| clean_v(value, 600)));
    clean(&parts.into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" "), 1_800)
}

/// Известные отряду места карты мира, кроме текущего, — до двенадцати.
fn known_places_for(state: &Value) -> Vec<String> {
    let here = text::lower(&clean_v(at(Some(state), &["scene", "location"]), 160));
    arr(at(Some(state), &["worldMap", "locations"]))
        .iter()
        .filter(|location| {
            let name = clean_v(prop(Some(location), "name"), 160);
            !js::is_false(prop(Some(location), "known")) && !name.is_empty() && text::lower(&name) != here
        })
        .map(|location| clean_v(prop(Some(location), "name"), 120))
        .take(12)
        .collect()
}

fn context_metadata(state: &Value, actor_id: &str) -> Value {
    let role = json!("action_adjudicator");
    let actor = json!(actor_id);
    let contract = json!(ACTION_ADJUDICATOR_PROMPT_VERSION);
    agent_context_metadata(state, &AgentContextOptions { role: Some(&role), actor_id: Some(&actor), target_id: None, contract_version: Some(&contract) })
}

/// `adjudicationBrief(state, actorId, text, dialogue)`: что видит модель —
/// лист героя, сцена, участники, предметы, экономия хода и закрытые списки.
pub fn adjudication_brief(state: &Value, actor_id: &str, value: &str, dialogue: Option<&Value>) -> Value {
    let (participants, participants_metadata) = participants_brief(state, actor_id);
    let (props, props_metadata) = scene_props_brief(state, actor_id);
    let mut brief = Map::new();
    brief.insert("context_metadata".into(), context_metadata(state, actor_id));
    brief.insert("player_action".into(), json!(clean(value, 1_000)));
    let recent = prop(dialogue, "recent");
    if length_truthy(recent) || js::truthy(prop(dialogue, "action")) {
        let entries = arr(recent);
        let skip = entries.len().saturating_sub(6);
        brief.insert(
            "dialogue".into(),
            json!({
                "request_kind": nullish(prop(dialogue, "request_kind"), None).cloned().unwrap_or_else(|| json!("action")),
                "action": clean_v(prop(dialogue, "action"), 1_000),
                "recent": entries.iter().skip(skip).map(|entry| json!({ "question": clean_v(prop(Some(entry), "question"), 500), "answer": clean_v(prop(Some(entry), "answer"), 800) })).collect::<Vec<_>>(),
            }),
        );
    }
    brief.insert("hero".into(), hero_brief(state, actor_id));
    brief.insert(
        "scene".into(),
        json!({
            "title": clean_v(at(Some(state), &["scene", "title"]), 120),
            "location": clean_v(at(Some(state), &["scene", "location"]), 120),
            "mood": clean_v(at(Some(state), &["scene", "mood"]), 160),
            "objective": clean_v(at(Some(state), &["scene", "objective"]), 160),
            "known_description": known_scene_description(state),
            "canon": scene_canon_for(state),
        }),
    );
    brief.insert("known_places".into(), json!(known_places_for(state)));
    brief.insert("participants".into(), Value::Array(participants));
    brief.insert("scene_props".into(), Value::Array(props));
    insert_selection_fields(&mut brief, &participants_metadata, "participants");
    insert_selection_fields(&mut brief, &props_metadata, "scene_props");
    brief.insert("turn_economy".into(), economy_brief(state, actor_id));
    brief.insert(
        "allowed".into(),
        json!({
            "effects": IMPROVISED_EFFECT_IDS,
            "hazards": ENVIRONMENT_HAZARD_IDS,
            "proficiency_levels": FREE_ACTION_PROFICIENCY_LEVELS,
            "consequence_types": FREE_ACTION_CONSEQUENCE_TYPES,
            "activity_kinds": FREE_ACTION_ACTIVITY_KINDS,
            "duration_classes": FREE_ACTION_DURATION_CLASSES,
        }),
    );
    Value::Object(brief)
}

enum ReadFailure {
    Other,
    /// `ACTION_ADJUDICATOR_REFERENCE_NOT_IN_CONTEXT` с `reference_fields`.
    References(Vec<&'static str>),
}

/// `ActionAdjudicator`.
#[derive(Clone)]
pub struct ActionAdjudicator {
    llm_client: Option<Arc<dyn LlmClient>>,
    /// `timeoutMs` как передан (JS отдаёт его клиенту без приведения).
    timeout_ms: Value,
    system_prompt: String,
}

/// Параметры [`ActionAdjudicator::discuss`].
#[derive(Debug, Clone, Default)]
pub struct DiscussOptions {
    pub action: String,
    pub recent: Vec<Value>,
    pub check: Option<Value>,
}

impl ActionAdjudicator {
    /// `new ActionAdjudicator({ llmClient, timeoutMs = 12_000, systemPrompt })`.
    /// `system_prompt` — подмена контракта только для замеров; пустая строка
    /// или `None` — встроенный промпт.
    pub fn new(llm_client: Option<Arc<dyn LlmClient>>, timeout_ms: Option<Value>, system_prompt: Option<String>) -> Self {
        let system_prompt = system_prompt.filter(|prompt| !text::trim(prompt).is_empty()).unwrap_or_else(|| ACTION_ADJUDICATOR_PROMPT.to_string());
        Self { llm_client, timeout_ms: timeout_ms.unwrap_or_else(|| Value::from(ACTION_ADJUDICATOR_DEFAULT_TIMEOUT_MS)), system_prompt }
    }

    /// `read(state, actorId, text, fallbackReading, dialogue)`: прочтение
    /// задумки. Отказ модели — возврат к детерминированному прочтению; наружу
    /// выходит только ошибка привязки к состоянию (как исключение в JS).
    pub async fn read(&self, state: &Value, actor_id: &str, value: &str, fallback_reading: &Value, dialogue: Option<&Value>) -> FreeActionResult<Value> {
        let metadata = context_metadata(state, actor_id);
        let with_metadata = |mut reading: Value| {
            if let Some(map) = reading.as_object_mut() {
                map.insert("context_metadata".into(), metadata.clone());
            }
            reading
        };
        if let Some(harmless) = harmless_free_action_reading(state, actor_id, value) {
            return Ok(with_metadata(bind_free_action_reading_to_state(state, actor_id, value, &harmless, false)?));
        }
        let Some(client) = self.llm_client.as_ref() else {
            return Ok(with_metadata(bind_free_action_reading_to_state(state, actor_id, value, fallback_reading, false)?));
        };
        match self.ask(client, state, actor_id, value, dialogue).await {
            Ok((bound, extras)) => {
                // `{ ...bound, context_metadata, ...route, ...details }`.
                let mut reading = with_metadata(bound);
                if let Some(map) = reading.as_object_mut() {
                    for (key, entry) in extras {
                        map.insert(key.into(), entry);
                    }
                }
                Ok(reading)
            }
            Err(failure) => {
                let mut fallback = if fallback_reading.is_object() { fallback_reading.clone() } else { json!({}) };
                let source = format!("{}-after-agent-error", js::string(fallback_reading.get("source")));
                if let Some(map) = fallback.as_object_mut() {
                    map.insert("source".into(), json!(source));
                }
                let mut bound = bind_free_action_reading_to_state(state, actor_id, value, &fallback, false)?;
                if let ReadFailure::References(fields) = failure {
                    let mut merged: IndexSet<String> = arr(bound.get("reference_ambiguities")).iter().map(|entry| js::s(Some(entry))).collect();
                    merged.extend(fields.into_iter().map(str::to_string));
                    bound["reference_ambiguities"] = json!(merged.into_iter().collect::<Vec<_>>());
                }
                Ok(with_metadata(bound))
            }
        }
    }

    /// Тело `try` в `read`: вызов модели, проверка ответа и привязка.
    /// `Err` — любая ошибка внутри `try` (ответ отбрасывается целиком).
    async fn ask(&self, client: &Arc<dyn LlmClient>, state: &Value, actor_id: &str, value: &str, dialogue: Option<&Value>) -> Result<(Value, Vec<(&'static str, Value)>), ReadFailure> {
        let brief = adjudication_brief(state, actor_id, value, dialogue);
        let request = json!({
            "messages": [
                { "role": "system", "content": self.system_prompt },
                { "role": "user", "content": build_data_only_context(Some(&json!({ "free_action_brief": brief }))) },
            ],
            "temperature": 0.2,
            "maxTokens": 1000,
        });
        let options = json!({ "timeoutMs": self.timeout_ms });
        let result = (**client).complete_json(&request, &options).await.map_err(|_| ReadFailure::Other)?;
        if !structurally_valid_free_action_response(&result) {
            return Err(ReadFailure::Other);
        }
        let participants = arr(brief.get("participants"));
        let participant_ids: HashSet<String> = participants.iter().map(|entry| js::s(entry.get("id"))).collect();
        let props = arr(brief.get("scene_props"));
        let prop_by_id = |id: &str| props.iter().rev().find(|entry| is_str(entry.get("id"), id));
        let field = |key: &str| js::s(result.get(key));
        let prop_intent = scene_prop_intent_for(&field("effect"));
        let inventory = arr(at(Some(&brief), &["hero", "inventory"]));
        let mut unknown = Vec::new();
        if !field("target_id").is_empty() && !participant_ids.contains(&field("target_id")) {
            unknown.push("target_id");
        }
        if !field("effect_target").is_empty() && !participant_ids.contains(&field("effect_target")) {
            unknown.push("effect_target");
        }
        if !field("item_id").is_empty() && !inventory.iter().any(|item| is_str(item.get("id"), &field("item_id"))) {
            unknown.push("item_id");
        }
        if !field("prop_id").is_empty() && (prop_by_id(&field("prop_id")).is_none() || prop_intent.is_none()) {
            unknown.push("prop_id");
        }
        if !unknown.is_empty() {
            return Err(ReadFailure::References(unknown));
        }
        let mut input = result.clone();
        if let Some(map) = input.as_object_mut() {
            map.insert("source".into(), json!("agent-adjudicator"));
        }
        let mut reading = normalize_free_action_reading(&input, value);
        let get = |reading: &Value, key: &str| js::s(reading.get(key));
        // Модель могла назвать эффект, которого нет в каталоге.
        if !IMPROVISED_EFFECT_IDS.contains(&get(&reading, "effect").as_str()) {
            reading["effect"] = json!("none");
        }
        let hazard = get(&reading, "hazard");
        if !hazard.is_empty() && !ENVIRONMENT_HAZARD_IDS.contains(&hazard.as_str()) {
            reading["hazard"] = json!("");
        }
        let effect_target = get(&reading, "effect_target");
        if !effect_target.is_empty() && !participant_ids.contains(&effect_target) {
            reading["effect_target"] = json!("");
        }
        // Предмет обстановки — только из переданного списка и только со своим глаголом.
        let intent = scene_prop_intent_for(&get(&reading, "effect"));
        let named = prop_by_id(&get(&reading, "prop_id"));
        let verb_ok = match (named, &intent) {
            (Some(entry), Some(intent)) => arr(entry.get("verbs")).iter().any(|verb| verb.as_str() == Some(intent.as_str())),
            _ => false,
        };
        if !verb_ok {
            reading["prop_id"] = json!("");
        }
        if intent.is_some() && get(&reading, "prop_id").is_empty() {
            reading["effect"] = json!("none");
        }
        let (route, destination, npc_hint) = route_from_response(&result, participants);
        let success = clean_success_detail(result.get("success_detail"));
        let surface = clean_success_detail(result.get("surface_detail"));
        let failure = clean_success_detail(result.get("failure_detail"));
        let bound = bind_free_action_reading_to_state(state, actor_id, value, &reading, false).map_err(|_| ReadFailure::Other)?;
        let mut extras = Vec::new();
        if route != "check" {
            extras.push(("route", json!(route)));
            extras.push(("destination", json!(destination)));
            extras.push(("npc_hint", json!(npc_hint)));
        }
        if !success.is_empty() {
            extras.push(("success_detail", json!(success)));
        }
        if !surface.is_empty() && surface != success {
            extras.push(("surface_detail", json!(surface)));
        }
        if !failure.is_empty() && failure != surface {
            extras.push(("failure_detail", json!(failure)));
        }
        Ok((bound, extras))
    }

    /// `discuss(state, actorId, question, { action, recent, check })`:
    /// обсуждение способа тем же арбитражем, без исполнения команд.
    pub async fn discuss(&self, state: &Value, actor_id: &str, question: &str, options: &DiscussOptions) -> FreeActionResult<Value> {
        if let Some(check) = options.check.as_ref().filter(|check| js::truthy(Some(check))) {
            let proposal = check.get("proposal").filter(|proposal| js::truthy(Some(proposal)));
            let terms = proposal.map_or(String::new(), |proposal| {
                format!(
                    " Цена попытки: {}. При успехе: {} При провале: {}",
                    clean_v(proposal.get("cost"), 240),
                    clean_v(proposal.get("on_success"), 400),
                    clean_v(proposal.get("on_failure"), 400)
                )
            });
            return Ok(json!({
                "narration": format!(
                    "{} Текущее предложение: {}, СЛ {}.{terms} Способ можно изменить до броска.",
                    explain_action_check(check),
                    js::string(check.get("label")),
                    js::string(check.get("difficulty"))
                ),
            }));
        }
        let hypothetical = question_action_text(question);
        if let Some(exploration) = resolve_exploration_command(state, actor_id, &hypothetical) {
            let command = is_str(exploration.get("status"), "command");
            let narration = if command {
                format!("{} Можно выполнить: «{hypothetical}». Подтвердите этот способ или измените его; пока ничего не выполнено.", js::string(exploration.get("narration")))
            } else {
                js::string(exploration.get("narration"))
            };
            let mut answer = Map::new();
            answer.insert("narration".into(), json!(narration));
            if command {
                answer.insert("proposed_action".into(), json!(hypothetical));
            }
            return Ok(Value::Object(answer));
        }
        if let Some(direct) = direct_contact_question(state, actor_id, &hypothetical)? {
            return Ok(direct);
        }
        let fallback = interpret_free_action(question);
        let dialogue = json!({ "action": options.action, "recent": options.recent, "request_kind": "question" });
        let reading = self.read(state, actor_id, question, &fallback, Some(&dialogue)).await?;
        let means = verify_means(state, actor_id, reading.get("required_means"));
        if !js::truthy(means.get("satisfied")) {
            let missing: Vec<String> = arr(means.get("missing")).iter().map(|entry| js::s(Some(entry))).collect();
            return Ok(json!({ "narration": format!("Для этого понадобится {} — а этого у героя под рукой нет. Найдёте — можно будет пробовать.", missing.join(", ")), "reading": reading }));
        }
        let resolution = contextual_resolution_for(state, actor_id, &reading, question);
        if is_str(resolution.get("mode"), "counter_offer") {
            return Ok(json!({ "narration": "Обычной проверки здесь недостаточно: назовите заклинание, предмет или способность, которые дают нужную возможность. После этого можно обсудить безопасный способ.", "reading": reading }));
        }
        let uncertain = js::string(reading.get("source")).starts_with("deterministic-default") && !has_recognized_free_action_approach(question);
        if uncertain {
            let props: Vec<String> = scene_props_brief(state, actor_id).0.iter().take(3).map(|entry| js::string(entry.get("name"))).collect();
            let props = props.join(", ");
            let kept = if options.action.is_empty() { String::new() } else { format!(" Сохраняю исходную заявку: «{}».", clean(&options.action, 300)) };
            let available = if props.is_empty() { String::new() } else { format!(" Из доступной обстановки можно использовать: {props}.") };
            return Ok(json!({ "narration": format!("Чтобы оценить этот вариант, уточним, чем герой действует и какой результат ему нужен.{kept}{available} Вопрос ничего не расходует."), "reading": reading }));
        }
        let label = d20_check_label(&json!({ "kind": "check", "ability": reading.get("ability"), "skill": reading.get("skill") }));
        let prop_id = js::s(reading.get("prop_id"));
        let found = if js::truthy(reading.get("prop_id")) { scene_props_brief(state, actor_id).0.into_iter().find(|entry| is_str(entry.get("id"), &prop_id)) } else { None };
        if let Some(found) = &found {
            let name = clean_v(found.get("name"), 80);
            if is_str(reading.get("effect"), "ignite_prop") {
                return Ok(json!({ "narration": format!("«{name}» займётся огнём, и пламя станет опасно всем, кто окажется рядом. Поджечь можно вплотную и только если есть чем — огонь, факел или огниво. Заявите это действием, и вы увидите условия до того, как что-то случится."), "reading": reading }));
            }
            if is_str(reading.get("effect"), "topple_prop") {
                return Ok(json!({ "narration": format!("«{name}» можно опрокинуть — понадобится сила, а всё, что окажется под ним, пострадает. Заявите это действием, и вы увидите условия до того, как что-то случится."), "reading": reading }));
            }
        }
        let narration = if is_str(resolution.get("mode"), "auto_success") {
            "Броска это не потребует — скажите, что делаете, и посмотрим, как отзовётся мир.".to_string()
        } else {
            format!("{} Скорее всего, понадобится {label}. Заявите действие — и до броска вы увидите сложность и чем грозит провал; передумать можно и тогда.", explain_action_check(&reading))
        };
        Ok(json!({ "narration": narration, "reading": reading }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_is_embedded_as_blob() {
        assert!(ACTION_ADJUDICATOR_PROMPT.len() > 1_000);
        assert!(!ACTION_ADJUDICATOR_PROMPT.contains('\r'));
    }
}

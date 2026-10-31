//! Перенос `server/campaign-loop-policy.mjs`: серверная политика автономного
//! цикла кампании.
//!
//! Здесь решается, какое намерение Режиссёра (модели или запасного пути без
//! модели) допустимо в текущей фазе, чем заменить застой, как растёт
//! напряжение, куда вести отряд по карте мира, сколько идёт дорога и бывает ли
//! в пути стычка, кого из местных привести в социальную сцену и чем кончается
//! отдых. Кампания по авторскому сценарию берёт фазу, следующее место и встречу
//! из `campaign-scenario`; кампания без сценария живёт по вечерней арке
//! (`skazanie:campaign-arc-v1`).
//!
//! Расхождение с JS одно, общее для всего модуля: на мусоре старых сохранений
//! (не массив вместо списка, `null` вместо задания, ключ прототипа вместо фазы)
//! JS бросает `TypeError`, а Rust читает такое поле как пустое или неизвестное
//! и отвечает, как на отсутствующее.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{hash, js, re, text as jstext, v8math};
use sk_memory::world_memory::CLOSED_QUEST_STATUSES;
use sk_scenario::campaign_scenario::{
    build_scenario_arc_plan, campaign_scenario, scenario_destination_ids, scenario_encounter_for, scenario_ending, scenario_phase, scenario_progress,
    SCENARIO_ARC_VERSION,
};
use sk_attention::scenario_attention::{scenario_stranger_npc_id, scenario_stranger_stage};
use sk_social::npc_social::npc_witnessed_fact_ids;
use sk_society::campaign_stories::{campaign_mode_for, persistent_story_quest};
use sk_world_story::autonomous_campaign::{normalize_director_intent, DirectorIntentError};

pub use sk_memory::world_memory::{quest_progress_evidence_for, QUEST_ABANDONMENT_NEXT_OBJECTIVE};

pub const ONE_EVENING_ARC_VERSION: &str = "skazanie:campaign-arc-v1";
pub const ONE_EVENING_PRESET: &str = "one_evening";

/// Потолок длины цепочки арок: номер арки входит в seed и идентификаторы глав.
pub const MAX_CAMPAIGN_ARCS: i64 = 12;

/// Путь к новому месту, которого нет на карте мира: оно рядом.
pub const NEW_PLACE_TRAVEL_MINUTES: i64 = 30;

const ONE_EVENING_CHAPTER_CLOCK_MAX: i64 = 2;
const ONE_EVENING_FORCE_AFTER_BEATS: i64 = 2;
const ONE_EVENING_MAX_DIRECTOR_BEATS: i64 = 5;

const PHASE_BY_TENSION: [(f64, &str); 4] = [(75.0, "climax"), (50.0, "escalation"), (25.0, "development"), (0.0, "breather")];

/// `PHASE_INTENT_TYPES[phase]` — только собственные ключи таблицы.
fn phase_intent_types(phase: &str) -> Option<&'static [&'static str]> {
    Some(match phase {
        "breather" => &["continue_exploration", "open_social_scene", "advance_quest_clock", "offer_next_hook"],
        "development" => &["advance_quest_clock", "continue_exploration", "open_social_scene", "request_encounter", "offer_next_hook"],
        "escalation" => &["advance_quest_clock", "request_encounter", "end_scene", "continue_exploration"],
        "climax" => &["advance_quest_clock", "resolve_scene", "offer_next_hook", "request_encounter", "end_scene"],
        _ => return None,
    })
}

/// `PACING_DELTAS[type] ?? 0`.
fn pacing_delta(kind: Option<&Value>) -> f64 {
    match kind.and_then(Value::as_str) {
        Some("continue_exploration") => 12.0,
        Some("open_social_scene") => 8.0,
        Some("advance_quest_clock") => 14.0,
        Some("request_encounter") => 24.0,
        Some("end_scene") => -30.0,
        Some("offer_next_hook") => 6.0,
        _ => 0.0,
    }
}

// ---------------------------------------------------------------------------
// Приведения JS
// ---------------------------------------------------------------------------

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

fn path<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value, |current, key| get(Some(current), key))
}

/// Массив или пусто (`Array.isArray(x) ? x : []` и `x ?? []` на мусоре).
fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn is_str(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

/// `a === b` для значений из JSON: объекты и массивы между собой не равны.
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

/// `text.slice(0, max)` в единицах UTF-16. Символ вне BMP, который JS разрезал
/// бы пополам, отбрасывается целиком: половину суррогатной пары строка Rust не
/// держит.
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
    head_utf16(&jstext::squash_spaces(&jstext::nfkc(&js::s(value))), maximum)
}

fn clean_str(text: &str, maximum: usize) -> String {
    head_utf16(&jstext::squash_spaces(&jstext::nfkc(text)), maximum)
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

/// `Math.max(a, b)` с заразным `NaN`.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)` с заразным `NaN`.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.max(minimum, Math.min(maximum, Number(value) || 0))`.
fn clamp(value: Option<&Value>, minimum: f64, maximum: f64) -> f64 {
    clamp_f64(number_or(value, 0.0), minimum, maximum)
}

fn clamp_f64(value: f64, minimum: f64, maximum: f64) -> f64 {
    let value = if value.is_nan() || value == 0.0 { 0.0 } else { value };
    js_max(minimum, js_min(maximum, value))
}

/// `x.length` для массива и строки; у прочего — `undefined`.
fn js_length(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Array(items)) => Some(items.len() as f64),
        Some(Value::String(text)) => Some(text.encode_utf16().count() as f64),
        _ => None,
    }
}

/// `Number.parseInt(sha256(JSON.stringify(value)).slice(0, 8), 16)`.
fn hash_number(value: &str) -> u64 {
    let digest = hash::sha256_hex(js::stringify(&Value::String(value.to_string())));
    u64::from_str_radix(&digest[..8], 16).unwrap_or(0)
}

/// Шаблонная подстановка `${value}` параметра с запасом `''`.
fn template(value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        other => js::string(other),
    }
}

/// `a.localeCompare(b, 'ru')`: явная русская локаль (кириллица раньше латиницы).
static RU_COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    let locale: icu_locale_core::Locale = icu_locale_core::locale!("ru");
    Collator::try_new(CollatorPreferences::from(&locale), CollatorOptions::default()).expect("сопоставитель строк ICU для ru")
});

pub fn locale_compare_ru(a: &str, b: &str) -> Ordering {
    RU_COLLATOR.compare(a, b)
}

fn chapter_of(state: &Value) -> f64 {
    js_max(1.0, number_or(path(state, &["adventure", "chapter"]), 1.0))
}

fn quests(state: &Value) -> &[Value] {
    array(path(state, &["worldMemory", "quests"]))
}

fn combat_active(state: &Value) -> bool {
    js::truthy(path(state, &["mechanics", "combat", "active"]))
}

// ---------------------------------------------------------------------------
// Оставленные задания
// ---------------------------------------------------------------------------

/// Краткий список уже оставленных заданий для brief Директора.
pub fn abandoned_quests_for_director(state: &Value) -> Vec<Value> {
    let abandoned: Vec<&Value> = quests(state).iter().filter(|quest| is_str(get(Some(quest), "status"), "abandoned")).collect();
    abandoned[abandoned.len().saturating_sub(12)..]
        .iter()
        .filter_map(|quest| {
            let quest = Some(*quest);
            let id = clean(get(quest, "id"), 120);
            let title = clean(get(quest, "title"), 180);
            let mut entry = Map::new();
            entry.insert("id".into(), Value::String(id.clone()));
            entry.insert("title".into(), Value::String(title.clone()));
            entry.insert("summary".into(), Value::String(clean(get(quest, "summary"), 360)));
            entry.insert("status".into(), json!("abandoned"));
            let clock = get(quest, "clock");
            if js::truthy(clock) {
                entry.insert(
                    "clock".into(),
                    json!({
                        "current": js::num(js_max(0.0, number_or(get(clock, "current"), 0.0))),
                        "max": js::num(js_max(1.0, number_or(get(clock, "max"), 1.0))),
                    }),
                );
            }
            (!id.is_empty() && !title.is_empty()).then_some(Value::Object(entry))
        })
        .collect()
}

/// Цель для продолжения после отказа (`directorObjectiveAfterQuestAbandonment`).
/// `fallback` — `None` даёт запас JS по умолчанию.
pub fn director_objective_after_quest_abandonment(state: &Value, fallback: Option<&str>) -> String {
    let fallback = fallback.unwrap_or("Исследовать текущую локацию и выбрать следующий шаг");
    let objective = clean(path(state, &["scene", "objective"]), 300);
    let active = quests(state).iter().find(|quest| {
        is_str(get(Some(quest), "status"), "active") && !js::is_true(path(quest, &["clock", "triggered"]))
    });
    if let Some(active) = active {
        return if objective.is_empty() { format!("Продолжить: {}", clean(active.get("title"), 180)) } else { objective };
    }
    if !abandoned_quests_for_director(state).is_empty() {
        return QUEST_ABANDONMENT_NEXT_OBJECTIVE.to_string();
    }
    if objective.is_empty() {
        clean_str(fallback, 300)
    } else {
        objective
    }
}

/// Отказ «остаться в локации» (`questWasAbandonedInPlace`).
pub fn quest_was_abandoned_in_place(quest: &Value) -> bool {
    is_str(quest.get("status"), "abandoned") && js::is_true(quest.get("stay_in_location"))
}

/// Прямая команда игрока начать бой или уйти (`affirmativePlayerAction`).
pub fn affirmative_player_action(value: Option<&Value>, kind: &str) -> bool {
    let text = jstext::lower(&clean(value, 500));
    if jstext::test(re!(r"(?:не хочу|не ищ|без боя|не вступ|не напада)", "u"), &text) {
        return false;
    }
    match kind {
        "encounter" => jstext::test(
            re!(r"^(?:мы\s+)?(?:ищем бой|хочу бой|начать бой|начинаем бой|вступаем в бой|атакуем|нападаем|сражаемся)(?=$|[\s,.!?:;])", "u"),
            &text,
        ),
        "transition" => jstext::test(re!(r"^(?:перейти|уйти|продолжить (?:путь|подтвержд[ёе]нный переход))(?=$|[\s,.!?:;])", "u"), &text),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Вечерняя арка
// ---------------------------------------------------------------------------

fn phase_for_evening_scene(scene_number: f64, target_scenes: f64) -> &'static str {
    if scene_number >= target_scenes {
        "climax"
    } else if scene_number == 1.0 {
        "breather"
    } else if scene_number == target_scenes - 1.0 {
        "escalation"
    } else {
        "development"
    }
}

/// Seed арки (`arcSeedFor`): номер арки — часть seed.
pub fn arc_seed_for(seed: Option<&Value>, arc_number: Option<&Value>) -> String {
    let number = js_max(1.0, number_or(arc_number, 1.0));
    if number <= 1.0 {
        clean(seed, 200)
    } else {
        format!("{}#arc{}", clean(seed, 200), js::f64_string(number))
    }
}

/// План вечерней арки (`buildCampaignArcPlan`).
pub fn build_campaign_arc_plan(seed: Option<&Value>, arc_number: Option<&Value>) -> Value {
    let number = js_max(1.0, js_min(MAX_CAMPAIGN_ARCS as f64, number_or(arc_number, 1.0).floor()));
    let normalized = clean(seed, 240);
    let normalized = if normalized.is_empty() { "one-evening".to_string() } else { normalized };
    let seed_value = Value::String(normalized.clone());
    let chained = arc_seed_for(Some(&seed_value), Some(&js::num(number)));
    let target_scenes = 3 + hash_number(&format!("{ONE_EVENING_ARC_VERSION}:{chained}")) % 3;
    json!({
        "version": ONE_EVENING_ARC_VERSION,
        "preset": ONE_EVENING_PRESET,
        "seed": normalized,
        "arc_number": js::num(number),
        "target_scenes": target_scenes,
        "chapter_clock_max": ONE_EVENING_CHAPTER_CLOCK_MAX,
        "force_after_beats": ONE_EVENING_FORCE_AFTER_BEATS,
        "max_director_beats": ONE_EVENING_MAX_DIRECTOR_BEATS,
        "climax": "resolution",
    })
}

/// План арки кампании (`campaignArcPlan`) или `None`.
pub fn campaign_arc_plan(state: &Value) -> Option<Value> {
    if campaign_mode_for(state) == "persistent" {
        return None;
    }
    let raw = path(state, &["campaignConcept", "arc"]);
    if is_str(get(raw, "version"), SCENARIO_ARC_VERSION) {
        return campaign_scenario(state).map(build_scenario_arc_plan);
    }
    if !js::truthy(raw) || !is_str(get(raw, "version"), ONE_EVENING_ARC_VERSION) || !is_str(get(raw, "preset"), ONE_EVENING_PRESET) {
        return None;
    }
    let canonical = build_campaign_arc_plan(get(raw, "seed"), get(raw, "arc_number"));
    strict_eq(get(raw, "target_scenes"), canonical.get("target_scenes")).then_some(canonical)
}

/// Позиция в арке: значение для наружу и поля, которые читает политика.
struct ArcPosition {
    value: Value,
    phase: String,
    is_final: bool,
    target_scenes: f64,
    scene_number: f64,
}

fn arc_position(state: &Value) -> Option<ArcPosition> {
    let plan = campaign_arc_plan(state)?;
    let target_scenes = js::number(plan.get("target_scenes"));
    let max_beats = js::number(plan.get("max_director_beats"));
    let scene_number = chapter_of(state);
    let bounded = js_min(target_scenes, scene_number);
    let scene_beat = current_chapter_intents(state).len() as f64;
    let chapter_quest = chapter_quest_for(state, scene_number);
    let main_quest = main_quest_for(state);
    let scenario = scenario_progress(state);
    let phase = match &scenario {
        Some(_) => scenario_phase(state).unwrap_or("breather"),
        None => phase_for_evening_scene(bounded, target_scenes),
    };
    let is_final = match &scenario {
        Some(progress) => progress.at_boss_location,
        None => scene_number >= target_scenes,
    };
    let or_null = |value: Option<&Value>| value.cloned().unwrap_or(Value::Null);
    let mut value = plan;
    if let Value::Object(map) = &mut value {
        map.insert("scene_number".into(), js::num(scene_number));
        map.insert("bounded_scene_number".into(), js::num(bounded));
        map.insert("scene_beat".into(), js::num(scene_beat));
        map.insert("remaining_beats".into(), js::num(js_max(0.0, max_beats - scene_beat)));
        map.insert("phase".into(), json!(phase));
        map.insert("is_final".into(), json!(is_final));
        map.insert("chapter_quest_id".into(), or_null(get(chapter_quest, "id")));
        map.insert("chapter_quest_status".into(), or_null(get(chapter_quest, "status")));
        map.insert("main_quest_id".into(), or_null(get(main_quest, "id")));
        map.insert("main_quest_status".into(), or_null(get(main_quest, "status")));
    }
    Some(ArcPosition { value, phase: phase.to_string(), is_final, target_scenes, scene_number })
}

/// Позиция отряда в арке (`campaignArcPosition`) или `None`.
pub fn campaign_arc_position(state: &Value) -> Option<Value> {
    arc_position(state).map(|position| position.value)
}

fn current_phase(state: &Value) -> String {
    if let Some(arc) = arc_position(state) {
        return arc.phase;
    }
    let stored = clean(path(state, &["autonomy", "pacing", "phase"]), 30);
    if phase_intent_types(&stored).is_some() {
        return stored;
    }
    phase_by_tension(clamp(path(state, &["autonomy", "pacing", "tension"]), 0.0, 100.0)).to_string()
}

fn phase_by_tension(tension: f64) -> &'static str {
    PHASE_BY_TENSION.iter().find(|(threshold, _)| tension >= *threshold).map_or("breather", |(_, phase)| phase)
}

/// Намерения текущей главы: всё после последнего `end_scene`.
fn current_chapter_intents(state: &Value) -> Vec<&Value> {
    let intents: Vec<&Value> = array(path(state, &["autonomy", "director_history"]))
        .iter()
        .map(|entry| match get(Some(entry), "intent") {
            None | Some(Value::Null) => entry,
            Some(intent) => intent,
        })
        .filter(|entry| matches!(entry, Value::Object(_) | Value::Array(_)))
        .collect();
    let last_end = intents.iter().rposition(|intent| is_str(get(Some(intent), "type"), "end_scene"));
    intents[last_end.map_or(0, |index| index + 1)..].to_vec()
}

/// Есть ли подтверждённое продвижение поручения (`confirmedQuestProgress`).
pub fn confirmed_quest_progress(state: &Value, quest_id: &str) -> bool {
    !quest_progress_evidence_for(state, quest_id, false).is_empty()
}

/// Главная нить для проверки финала (`mainQuestFor`).
pub fn main_quest_for(state: &Value) -> Option<&Value> {
    if campaign_mode_for(state) == "persistent" {
        return persistent_story_quest(state);
    }
    let all = quests(state);
    let non_scene: Vec<&Value> = all.iter().filter(|quest| !js::s(get(Some(quest), "id")).starts_with("quest:chapter:")).collect();
    let open = |quest: &&Value| !quest_was_abandoned_in_place(quest);
    let found = if non_scene.is_empty() { all.iter().find(open) } else { non_scene.into_iter().find(open) };
    found.filter(|quest| !quest.is_null())
}

fn chapter_quest_for(state: &Value, chapter: f64) -> Option<&Value> {
    let wanted = format!("quest:chapter:{}", js::f64_string(chapter));
    quests(state).iter().find(|quest| quest.is_object() && js::string(quest.get("id")) == wanted)
}

fn encounter_outcomes(state: &Value) -> &[Value] {
    array(path(state, &["autonomy", "encounter_outcomes"]))
}

fn encounter_outcome_recorded(state: &Value, encounter: Option<&Value>) -> bool {
    let id = get(encounter, "id");
    if !js::truthy(id) {
        return false;
    }
    encounter_outcomes(state).iter().any(|entry| strict_eq(get(Some(entry), "encounter_id"), id))
}

fn encounter_won_or_settled(state: &Value, encounter: Option<&Value>) -> bool {
    let id = get(encounter, "id");
    encounter_outcomes(state)
        .iter()
        .rev()
        .find(|entry| entry.is_object() && strict_eq(entry.get("encounter_id"), id))
        .is_some_and(|entry| !matches!(js::string(entry.get("outcome")).as_str(), "party_defeated" | "party_incapacitated"))
}

/// Достигнута ли развязка арки (`campaignArcClimaxSatisfied`).
pub fn campaign_arc_climax_satisfied(state: &Value) -> bool {
    if campaign_scenario(state).is_some() {
        return scenario_ending(state).is_some();
    }
    let Some(position) = arc_position(state) else {
        return false;
    };
    if !position.is_final {
        return false;
    }
    let target = position.target_scenes;
    let encounter = path(state, &["mechanics", "encounter"]);
    let combat_resolved = js::truthy(encounter)
        && is_str(get(encounter, "status"), "ended")
        && is_str(get(encounter, "difficulty"), "hard")
        && js::number(get(encounter, "created_in_chapter")) >= target
        && encounter_outcome_recorded(state, encounter)
        && encounter_won_or_settled(state, encounter);
    let scene_resolved = array(path(state, &["autonomy", "scene_resolutions"])).iter().any(|entry| {
        is_str(get(Some(entry), "status"), "confirmed")
            && js::number(get(Some(entry), "chapter")) >= target
            && matches!(get(Some(entry), "resolution").and_then(Value::as_str), Some("negotiation" | "objective" | "decision"))
    });
    combat_resolved || scene_resolved
}

fn first_open_quest(state: &Value) -> Option<&Value> {
    let active: Vec<&Value> = quests(state).iter().filter(|quest| is_str(get(Some(quest), "status"), "active")).collect();
    active
        .iter()
        .find(|quest| confirmed_quest_progress(state, &template(quest.get("id"))))
        .or_else(|| active.iter().find(|quest| !js::truthy(path(quest, &["clock", "triggered"]))))
        .copied()
}

struct Availability<'a> {
    phase: String,
    arc: Option<ArcPosition>,
    open_quest: Option<&'a Value>,
    types: Vec<&'static str>,
}

fn available_intent_types(state: &Value) -> Availability<'_> {
    let phase = current_phase(state);
    let arc = arc_position(state);
    let open_quest = first_open_quest(state);
    let encounter = path(state, &["mechanics", "encounter"]);
    let outcomes = encounter_outcomes(state);
    let encounter_resolved = is_str(get(encounter, "status"), "ended")
        && outcomes.iter().any(|entry| strict_eq(get(Some(entry), "encounter_id"), get(encounter, "id")));
    let chapter = chapter_of(state);
    let chapter_quest = chapter_quest_for(state, chapter);
    let chapter_quest_resolved = chapter_quest
        .is_some_and(|quest| CLOSED_QUEST_STATUSES.iter().any(|status| is_str(quest.get("status"), status)));
    let main_quest = main_quest_for(state);
    let main_quest_open = js::truthy(main_quest) && matches!(get(main_quest, "status").and_then(Value::as_str), Some("active" | "hidden"));
    let chapter_history = current_chapter_intents(state);
    let peaceful_second_chapter_exit = chapter == 2.0
        && !outcomes.is_empty()
        && chapter_history.iter().any(|intent| is_str(get(Some(intent), "type"), "advance_quest_clock"));
    let scenario = scenario_progress(state);
    let scenario_place_settled = scenario
        .as_ref()
        .is_some_and(|progress| !progress.clues.iter().any(|clue| clue.location_id == progress.current_location_id && !clue.found));
    let climax_satisfied = || campaign_arc_climax_satisfied(state);
    let end_scene_available = match &arc {
        Some(arc) => (!arc.is_final && (chapter_quest_resolved || scenario_place_settled)) || (arc.is_final && climax_satisfied()),
        None => encounter_resolved || peaceful_second_chapter_exit || (chapter_quest_resolved && !main_quest_open),
    };
    let base = phase_intent_types(&phase).unwrap_or(&[]);
    let mut phase_types: Vec<&'static str> = base.to_vec();
    if end_scene_available && !phase_types.contains(&"end_scene") {
        phase_types.push("end_scene");
    }
    let arc_final = arc.as_ref().is_some_and(|arc| arc.is_final);
    let types = phase_types
        .into_iter()
        .filter(|kind| match *kind {
            "advance_quest_clock" => open_quest.is_some_and(|quest| confirmed_quest_progress(state, &template(quest.get("id")))),
            "request_encounter" => {
                let replace_resolved_final = arc_final
                    && is_str(get(encounter, "status"), "ended")
                    && encounter_outcome_recorded(state, encounter)
                    && !climax_satisfied();
                !combat_active(state)
                    && (!js::truthy(encounter) || replace_resolved_final)
                    && !array(state.get("enemies")).iter().any(|enemy| {
                        let hp = match get(Some(enemy), "hp") {
                            None | Some(Value::Null) => 1.0,
                            hp => js::number(hp),
                        };
                        !js::is_false(get(Some(enemy), "alive")) && hp > 0.0
                    })
            }
            "resolve_scene" => arc_final && chapter_quest_resolved,
            "end_scene" => !combat_active(state) && end_scene_available,
            _ => true,
        })
        .collect();
    Availability { phase, arc, open_quest, types }
}

fn normalize(intent: Value) -> Result<Value, DirectorIntentError> {
    normalize_director_intent(Some(&intent))
}

fn intent_for_type(kind: &str, state: &Value, open_quest: Option<&Value>) -> Result<Value, DirectorIntentError> {
    match kind {
        "open_social_scene" => {
            let location = jstext::lower(&clean(path(state, &["scene", "location"]), 180));
            let npc = array(path(state, &["social", "npcs"])).iter().find(|entry| {
                let entry_location = get(Some(entry), "location");
                !js::is_false(get(Some(entry), "available"))
                    && (!js::truthy(entry_location) || location.is_empty() || jstext::lower(&clean(entry_location, 180)) == location)
            });
            let mut intent = Map::new();
            intent.insert("type".into(), json!(kind));
            if let Some(id) = get(npc, "id").filter(|id| js::truthy(Some(id))) {
                intent.insert("npc_id".into(), id.clone());
            }
            intent.insert("reason".into(), json!("Серверная политика темпа открывает содержательную социальную сцену."));
            normalize(Value::Object(intent))
        }
        "advance_quest_clock" => {
            let mut intent = Map::new();
            intent.insert("type".into(), json!(kind));
            if let Some(id) = get(open_quest, "id") {
                intent.insert("quest_id".into(), id.clone());
            }
            intent.insert("reason".into(), json!("Серверная политика темпа продвигает подтверждённую активную цель."));
            normalize(Value::Object(intent))
        }
        "request_encounter" => scenario_encounter_intent(
            state,
            &json!({
                "type": kind,
                "theme": "beasts",
                "difficulty": if current_phase(state) == "climax" { "hard" } else { "medium" },
                "reason": "Серверная политика темпа требует препятствия, разрешаемого правилами.",
            }),
        ),
        "end_scene" => {
            let chapter = chapter_of(state);
            let destination = campaign_scenario(state)
                .and_then(|_| next_world_map_destination(state))
                .unwrap_or_else(|| format!("След главы {}", js::f64_string(chapter + 1.0)));
            normalize(json!({
                "type": kind,
                "destination": destination,
                "reason": "Подтверждённая развязка позволяет перейти к следующей главе.",
            }))
        }
        "offer_next_hook" => {
            let hook = clean(path(state, &["scene", "objective"]), 300);
            normalize(json!({
                "type": kind,
                "hook": if hook.is_empty() { "Найти следующую подтверждаемую зацепку".to_string() } else { hook },
                "reason": "Сервер сохраняет доступный следующий шаг.",
            }))
        }
        _ => normalize(json!({
            "type": "continue_exploration",
            "reason": "Серверная политика темпа требует нового наблюдаемого шага.",
        })),
    }
}

/// `{ ...value }`: собственные перечислимые ключи; у строки — её символы.
fn spread_source(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Value::String(text) => text
            .encode_utf16()
            .collect::<Vec<u16>>()
            .iter()
            .enumerate()
            .map(|(index, unit)| (index.to_string(), Value::String(String::from_utf16_lossy(&[*unit]))))
            .collect(),
        _ => Map::new(),
    }
}

/// Встреча по сценарию (`scenarioEncounterIntent`): в логове — главный
/// противник, в месте со своей встречей — тема и сложность карточки.
pub fn scenario_encounter_intent(state: &Value, intent: &Value) -> Result<Value, DirectorIntentError> {
    let Some(planned) = scenario_encounter_for(state) else {
        return normalize_director_intent(Some(intent));
    };
    let mut merged = spread_source(intent);
    // Поле `undefined` в JS остаётся ключом объекта, но проверку контракта
    // проходит так же, как отсутствующее: здесь его просто нет.
    let mut set = |key: &str, value: Option<Value>| match value {
        Some(value) => {
            merged.insert(key.into(), value);
        }
        None => {
            merged.shift_remove(key);
        }
    };
    if planned.get("npc_id").is_some() {
        set("npc_id", planned.get("npc_id").cloned());
        set("difficulty", planned.get("difficulty").cloned());
        set("theme", Some(json!("generic")));
    } else {
        set("theme", planned.get("theme").cloned());
        set("difficulty", planned.get("difficulty").cloned());
    }
    normalize(Value::Object(merged))
}

/// Граница Режиссёра на сервере (`authorizeDirectorIntent`): модель предлагает
/// только ограниченное намерение; совместимость с фазой и замену застоя
/// решает сервер.
pub fn authorize_director_intent(state: &Value, proposed_intent: Option<&Value>, context: Option<&Value>) -> Result<Value, DirectorIntentError> {
    let proposed = normalize_director_intent(proposed_intent)?;
    let proposed_type = js::s(proposed.get("type"));
    let availability = available_intent_types(state);
    let history = current_chapter_intents(state);
    let last_type = clean(history.last().and_then(|entry| get(Some(entry), "type")), 40);
    let outcomes = path(state, &["autonomy", "director_outcomes"]);
    let last_outcome = match outcomes {
        Some(Value::Array(items)) => items.last(),
        _ => None,
    };
    let stalled_type = if js::is_false(get(last_outcome, "state_changed")) { clean(get(last_outcome, "intent_type"), 40) } else { String::new() };
    let blocked: HashSet<String> = [last_type, stalled_type].into_iter().filter(|kind| !kind.is_empty()).collect();
    let player_action = get(context, "playerAction");
    let explicit_encounter = proposed_type == "request_encounter" && affirmative_player_action(player_action, "encounter") && !combat_active(state);
    let explicit_transition = proposed_type == "end_scene" && affirmative_player_action(player_action, "transition") && !combat_active(state);
    let mut union: IndexSet<&'static str> = availability.types.iter().copied().collect();
    if explicit_encounter {
        union.insert("request_encounter");
    }
    if explicit_transition {
        union.insert("end_scene");
    }
    let allowed: Vec<&'static str> = union.into_iter().filter(|kind| !blocked.contains(*kind)).collect();
    let candidates: Vec<&'static str> = if !allowed.is_empty() {
        allowed
    } else if blocked.contains("offer_next_hook") {
        availability.types.clone()
    } else {
        vec!["offer_next_hook"]
    };
    let proposed_quest = if proposed_type == "advance_quest_clock" {
        let wanted = js::s(proposed.get("quest_id"));
        quests(state).iter().find(|quest| js::s(get(Some(quest), "id")) == wanted)
    } else {
        None
    };
    let stale_quest_intent = proposed_type == "advance_quest_clock"
        && match proposed_quest {
            None => true,
            Some(quest) => {
                !is_str(get(Some(quest), "status"), "active")
                    || (js::is_true(path(quest, &["clock", "triggered"])) && !confirmed_quest_progress(state, &template(get(Some(quest), "id"))))
            }
        };
    let accepted = candidates.contains(&proposed_type.as_str()) && !stale_quest_intent;
    let mut intent = if accepted {
        proposed.clone()
    } else {
        intent_for_type(candidates.first().copied().unwrap_or("continue_exploration"), state, availability.open_quest)?
    };
    if is_str(intent.get("type"), "request_encounter") && campaign_scenario(state).is_some() {
        intent = scenario_encounter_intent(state, &intent)?;
    }
    let stranger_stage = scenario_stranger_stage(state);
    if let Some(stage) = stranger_stage {
        intent = normalize(json!({
            "type": "open_social_scene",
            "npc_id": scenario_stranger_npc_id(state),
            "reason": format!("scenario-stranger:{stage}"),
        }))?;
    }
    let reason = if stranger_stage.is_some() {
        "scenario_stranger"
    } else if accepted {
        "intent_allowed"
    } else if stale_quest_intent {
        "closed_quest_replacement"
    } else if blocked.contains(&proposed_type) {
        "anti_stall_replacement"
    } else {
        "phase_incompatible_replacement"
    };
    Ok(json!({
        "intent": intent,
        "proposed_intent": proposed,
        "replaced": !accepted || stranger_stage.is_some(),
        "phase": availability.phase,
        "allowed_types": availability.types,
        "reason": reason,
        "policy": if availability.arc.is_some() { "director-intent-policy-one-evening-v1" } else { "director-intent-policy-v1" },
    }))
}

/// Отпечаток продвижения кампании (`directorProgressFingerprint`).
pub fn director_progress_fingerprint(state: &Value) -> String {
    let revealed = array(path(state, &["scene", "cells"])).iter().filter(|cell| js::is_true(get(Some(cell), "revealed"))).count();
    let quests: Vec<Value> = quests(state)
        .iter()
        .map(|quest| {
            json!({
                "id": clean(get(Some(quest), "id"), 120),
                "status": clean(get(Some(quest), "status"), 30),
                "current": js::num(number_or(path(quest, &["clock", "current"]), 0.0)),
                "triggered": js::is_true(path(quest, &["clock", "triggered"])),
            })
        })
        .collect();
    let encounter = path(state, &["mechanics", "encounter"]);
    let encounter = if js::truthy(encounter) {
        json!({
            "id": clean(get(encounter, "id"), 120),
            "status": clean(get(encounter, "status"), 40),
            "outcome": clean(get(encounter, "outcome"), 80),
        })
    } else {
        Value::Null
    };
    let value = json!({
        "chapter": js::num(chapter_of(state)),
        "scene": {
            "location": clean(path(state, &["scene", "location"]), 180),
            "objective": clean(path(state, &["scene", "objective"]), 300),
            "revealed_cells": revealed,
        },
        "quests": quests,
        "encounter": encounter,
        "lifecycle": clean(path(state, &["mechanics", "campaign_lifecycle", "status"]), 30),
    });
    hash::sha256_hex(js::stringify(&value))[..24].to_string()
}

/// Темп после намерения Режиссёра (`pacingForDirectorIntent`).
pub fn pacing_for_director_intent(state: &Value, intent: &Value) -> Value {
    let previous = match path(state, &["autonomy", "pacing"]) {
        None | Some(Value::Null) => None,
        other => other,
    };
    let arc = arc_position(state);
    let before = clamp(get(previous, "tension"), 0.0, 100.0);
    let delta = pacing_delta(intent.get("type"));
    let after = clamp_f64(before + delta, 0.0, 100.0);
    let phase = match &arc {
        Some(arc) if campaign_scenario(state).is_some() => arc.phase.clone(),
        Some(arc) => {
            let step = if is_str(intent.get("type"), "end_scene") { 1.0 } else { 0.0 };
            phase_for_evening_scene(js_min(arc.target_scenes, arc.scene_number + step), arc.target_scenes).to_string()
        }
        None => phase_by_tension(after).to_string(),
    };
    json!({
        "beat": js::num(js_max(0.0, number_or(get(previous, "beat"), 0.0)) + 1.0),
        "phase": phase,
        "tension_before": js::num(before),
        "tension_after": js::num(after),
        "delta": js::num(delta),
        "intent_type": clean(intent.get("type"), 40),
        "policy": if arc.is_some() { "campaign-pacing-one-evening-v1" } else { "campaign-pacing-v1" },
    })
}

fn recent_encounter_resolved(state: &Value) -> bool {
    let length = |key: &str| match path(state, &["autonomy", key]) {
        None | Some(Value::Null) => Some(0.0),
        other => js_length(other),
    };
    match (length("encounter_outcomes"), length("travel_history")) {
        (Some(outcomes), Some(travels)) => outcomes > travels,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Путешествие по графу мира
// ---------------------------------------------------------------------------

/// Полосы расстояния: (полоса, предел `distance`, минуты пути).
const TRAVEL_DISTANCE_BANDS: [(&str, f64, i64); 3] = [("near", 2.0, 45), ("regional", 5.0, 120), ("far", f64::INFINITY, 240)];

fn travel_base_minutes(band: &str) -> i64 {
    TRAVEL_DISTANCE_BANDS.iter().find(|(name, _, _)| *name == band).map_or(0, |(_, _, minutes)| *minutes)
}

/// `ROUTE_DANGER_RISK[danger] ?? 0` (только собственные ключи).
fn route_danger_risk(danger: &str) -> f64 {
    match danger {
        "низкая" | "low" => 5.0,
        "средняя" | "medium" => 12.0,
        "высокая" | "high" => 20.0,
        _ => 0.0,
    }
}

const WILD_ROUTE_KINDS: [&str; 4] = ["trail", "pass", "river", "sea"];
const WILD_BIOMES: [&str; 4] = ["forest", "marsh", "mountains", "wastes"];

fn biome_rank(biome: &str) -> i64 {
    match biome {
        "plains" => 0,
        "coast" => 1,
        "tundra" => 2,
        "desert" => 3,
        "forest" => 4,
        "marsh" => 5,
        "mountains" => 6,
        "wastes" => 7,
        _ => -1,
    }
}

fn encounter_themes_for(biome: &str) -> &'static [&'static str] {
    match biome {
        "plains" | "coast" => &["raiders", "goblinoids"],
        "tundra" => &["beasts", "raiders"],
        "desert" => &["raiders", "beasts"],
        "forest" => &["beasts", "goblinoids"],
        "marsh" => &["undead", "beasts"],
        "mountains" => &["goblinoids", "beasts"],
        "wastes" => &["undead", "raiders"],
        _ => &["raiders", "goblinoids"],
    }
}

const WORLD_GRID_DISTANCE_UNIT: f64 = 48.0;
const NO_ROUTE_DANGER_RISK: f64 = 15.0;

fn name_key(value: Option<&Value>) -> String {
    jstext::lower(&clean(value, 180))
}

struct Graph<'a> {
    locations: Vec<&'a Value>,
    by_id: IndexMap<String, &'a Value>,
    routes: Vec<&'a Value>,
    biome_by_region_id: HashMap<String, String>,
    current_location_id: String,
}

fn world_travel_graph(state: &Value) -> Option<Graph<'_>> {
    let map = state.get("worldMap").filter(|map| map.is_object())?;
    let locations: Vec<&Value> = array(map.get("locations")).iter().filter(|location| location.is_object() && !clean(location.get("id"), 120).is_empty()).collect();
    if locations.is_empty() {
        return None;
    }
    let mut by_id: IndexMap<String, &Value> = IndexMap::new();
    for location in &locations {
        by_id.insert(clean(location.get("id"), 120), location);
    }
    let routes: Vec<&Value> = array(map.get("routes"))
        .iter()
        .filter(|route| {
            let from = clean(get(Some(route), "from"), 120);
            let to = clean(get(Some(route), "to"), 120);
            route.is_object() && by_id.contains_key(&from) && by_id.contains_key(&to) && from != to && !js::is_false(route.get("discovered"))
        })
        .collect();
    let biome_by_region_id = array(map.get("regions"))
        .iter()
        .filter(|region| region.is_object() || region.is_array())
        .map(|region| (clean(get(Some(region), "id"), 120), clean(get(Some(region), "biome"), 40)))
        .collect();
    Some(Graph { locations, by_id, routes, biome_by_region_id, current_location_id: clean(map.get("currentLocationId"), 120) })
}

fn graph_location<'a>(graph: &Graph<'a>, location_id: Option<&Value>, name: Option<&Value>) -> Option<&'a Value> {
    if let Some(found) = graph.by_id.get(&clean(location_id, 120)) {
        return Some(found);
    }
    let expected = name_key(name);
    if expected.is_empty() {
        return None;
    }
    graph.locations.iter().find(|location| name_key(location.get("name")) == expected).copied()
}

fn route_ends(route: &Value) -> (String, String) {
    (clean(route.get("from"), 120), clean(route.get("to"), 120))
}

/// Куда вести отряд, когда Режиссёр закрывает сцену без названного места
/// (`nextWorldMapDestination`): по сценарию — ближайшее место сюжета, иначе
/// ближайшая непосещённая точка, иначе ближайший сосед. `None` — карты мира
/// нет или идти некуда.
pub fn next_world_map_destination(state: &Value) -> Option<String> {
    let graph = world_travel_graph(state)?;
    let current_location_id = Value::String(graph.current_location_id.clone());
    let current = graph_location(&graph, Some(&current_location_id), path(state, &["scene", "location"]))?;
    let current_id = clean(current.get("id"), 120);
    let non_empty = |name: String| (!name.is_empty()).then_some(name);
    let targets = scenario_destination_ids(state);
    if !targets.is_empty() {
        if let Some(reachable) = nearest_world_location(&graph, &current_id, |location| targets.contains(&clean(location.get("id"), 120))) {
            return non_empty(clean(reachable.get("name"), 180));
        }
    }
    if let Some(unvisited) = nearest_world_location(&graph, &current_id, |location| !js::is_true(location.get("visited"))) {
        return non_empty(clean(unvisited.get("name"), 180));
    }
    let mut neighbours: Vec<(&Value, &Value)> = graph
        .routes
        .iter()
        .filter_map(|route| {
            let (from, to) = route_ends(route);
            if from != current_id && to != current_id {
                return None;
            }
            let other = if from == current_id { to } else { from };
            graph.by_id.get(&other).map(|location| (*route, *location))
        })
        .collect();
    neighbours.sort_by(|(left_route, left), (right_route, right)| {
        let visited = |location: &Value| i64::from(js::is_true(location.get("visited")));
        visited(left)
            .cmp(&visited(right))
            .then_with(|| segment_distance(&graph, left_route).partial_cmp(&segment_distance(&graph, right_route)).unwrap_or(Ordering::Equal))
            .then_with(|| locale_compare_ru(&clean(left.get("name"), 180), &clean(right.get("name"), 180)))
    });
    non_empty(clean(neighbours.first().and_then(|(_, location)| location.get("name")), 180))
}

/// Дейкстра по открытым дорогам: ближайшая точка, которую принимает `accept`.
fn nearest_world_location<'a>(graph: &Graph<'a>, current_id: &str, accept: impl Fn(&Value) -> bool) -> Option<&'a Value> {
    let mut distance: IndexMap<String, f64> = IndexMap::new();
    distance.insert(current_id.to_string(), 0.0);
    let mut done: HashSet<String> = HashSet::new();
    loop {
        let mut nearest: Option<(&String, f64)> = None;
        for (id, value) in &distance {
            if !done.contains(id) && nearest.is_none_or(|(_, best)| *value < best) {
                nearest = Some((id, *value));
            }
        }
        let Some((nearest, nearest_distance)) = nearest.map(|(id, value)| (id.clone(), value)) else {
            break;
        };
        done.insert(nearest.clone());
        if let Some(location) = graph.by_id.get(&nearest) {
            if nearest != current_id && accept(location) {
                return Some(location);
            }
        }
        for route in &graph.routes {
            let (from, to) = route_ends(route);
            if from != nearest && to != nearest {
                continue;
            }
            let other = if from == nearest { to } else { from };
            let next = nearest_distance + js_max(1.0, segment_distance(graph, route));
            if !done.contains(&other) && next < distance.get(&other).copied().unwrap_or(f64::INFINITY) {
                distance.insert(other, next);
            }
        }
    }
    None
}

fn route_endpoints<'a>(graph: &Graph<'a>, route: &Value) -> Vec<&'a Value> {
    let (from, to) = route_ends(route);
    [graph.by_id.get(&from), graph.by_id.get(&to)].into_iter().flatten().copied().collect()
}

fn location_biome(graph: &Graph<'_>, location: Option<&Value>) -> String {
    graph.biome_by_region_id.get(&clean(get(location, "regionId"), 120)).cloned().unwrap_or_default()
}

fn straight_distance(from: Option<&Value>, to: Option<&Value>) -> f64 {
    let dx = number_or(get(from, "x"), 0.0) - number_or(get(to, "x"), 0.0);
    let dy = number_or(get(from, "y"), 0.0) - number_or(get(to, "y"), 0.0);
    js_max(1.0, js::round(v8math::hypot(dx, dy) / WORLD_GRID_DISTANCE_UNIT))
}

fn segment_distance(graph: &Graph<'_>, route: &Value) -> f64 {
    let parsed = js::number(route.get("distance"));
    if parsed.is_finite() {
        return js_max(0.0, js::round(parsed));
    }
    let ends = route_endpoints(graph, route);
    straight_distance(ends.first().copied(), ends.get(1).copied())
}

/// Кратчайший путь по дням дороги, при равенстве — по числу сегментов.
fn route_path<'a>(graph: &Graph<'a>, from_id: &str, to_id: &str) -> Option<Vec<&'a Value>> {
    if from_id == to_id {
        return Some(Vec::new());
    }
    let mut neighbours: IndexMap<String, Vec<(&'a Value, String)>> = IndexMap::new();
    for route in &graph.routes {
        let (from, to) = route_ends(route);
        neighbours.entry(from.clone()).or_default();
        neighbours.entry(to.clone()).or_default();
        if let Some(list) = neighbours.get_mut(&from) {
            list.push((*route, to.clone()));
        }
        if let Some(list) = neighbours.get_mut(&to) {
            list.push((*route, from));
        }
    }
    if !neighbours.contains_key(from_id) {
        return None;
    }
    let mut best: IndexMap<String, (f64, Vec<&'a Value>)> = IndexMap::new();
    best.insert(from_id.to_string(), (0.0, Vec::new()));
    let mut settled: HashSet<String> = HashSet::new();
    loop {
        let mut current: Option<(&String, &(f64, Vec<&'a Value>))> = None;
        for (id, entry) in &best {
            if settled.contains(id) {
                continue;
            }
            let better = match current {
                None => true,
                Some((_, known)) => entry.0 < known.0 || (entry.0 == known.0 && entry.1.len() < known.1.len()),
            };
            if better {
                current = Some((id, entry));
            }
        }
        let (current_id, (days, current_path)) = current.map(|(id, entry)| (id.clone(), entry.clone()))?;
        if current_id == to_id {
            return Some(current_path);
        }
        settled.insert(current_id.clone());
        for (route, next) in neighbours.get(&current_id).cloned().unwrap_or_default() {
            if settled.contains(&next) {
                continue;
            }
            let next_days = days + js_max(1.0, segment_distance(graph, route));
            let mut next_path = current_path.clone();
            next_path.push(route);
            let replace = match best.get(&next) {
                None => true,
                Some(known) => next_days < known.0 || (next_days == known.0 && next_path.len() < known.1.len()),
            };
            if replace {
                best.insert(next, (next_days, next_path));
            }
        }
    }
}

/// Более опасный биом из встреченных; при равенстве — регион цели.
fn path_biome(graph: &Graph<'_>, locations: &[&Value], destination: &Value) -> String {
    let mut biome = location_biome(graph, Some(destination));
    for location in locations {
        let candidate = location_biome(graph, Some(location));
        if biome_rank(&candidate) > biome_rank(&biome) {
            biome = candidate;
        }
    }
    biome
}

fn distance_band_for(distance: f64) -> &'static str {
    TRAVEL_DISTANCE_BANDS.iter().find(|(_, max, _)| distance <= *max).map_or("far", |(band, _, _)| band)
}

struct TravelFacts {
    source: &'static str,
    band: &'static str,
    wilderness: bool,
    danger_risk: f64,
    theme_options: &'static [&'static str],
    route_id: Option<String>,
    no_route: bool,
}

fn graph_travel_facts(graph: &Graph<'_>, origin: &Value, destination: &Value) -> TravelFacts {
    let Some(segments) = route_path(graph, &clean(origin.get("id"), 120), &clean(destination.get("id"), 120)) else {
        let biome = path_biome(graph, &[origin, destination], destination);
        return TravelFacts {
            source: "graph",
            band: distance_band_for(straight_distance(Some(origin), Some(destination))),
            wilderness: true,
            danger_risk: NO_ROUTE_DANGER_RISK,
            theme_options: encounter_themes_for(&biome),
            route_id: None,
            no_route: true,
        };
    };
    let distance: f64 = segments.iter().fold(0.0, |total, route| total + segment_distance(graph, route));
    let danger_risk = segments
        .iter()
        .fold(0.0, |worst, route| js_max(worst, route_danger_risk(&jstext::lower(&clean(route.get("danger"), 40)))));
    let wilderness = segments.iter().any(|route| {
        WILD_ROUTE_KINDS.contains(&jstext::lower(&clean(route.get("kind"), 30)).as_str())
            || route_endpoints(graph, route).iter().any(|location| WILD_BIOMES.contains(&location_biome(graph, Some(location)).as_str()))
    });
    let along: Vec<&Value> = segments.iter().flat_map(|route| route_endpoints(graph, route)).collect();
    let biome = path_biome(graph, &along, destination);
    TravelFacts {
        source: "graph",
        band: distance_band_for(distance),
        wilderness,
        danger_risk,
        theme_options: encounter_themes_for(&biome),
        route_id: match segments.as_slice() {
            [single] => Some(clean(single.get("id"), 100)).filter(|id| !id.is_empty()),
            _ => None,
        },
        no_route: false,
    }
}

/// ПУТЬ СОВМЕСТИМОСТИ для кампаний без графа мира: числа обязаны совпадать с
/// прежним поведением сохранённых кампаний.
fn legacy_text_travel_facts(state: &Value, from: &str, to: &str, entropy: u64) -> TravelFacts {
    let scene_kind = jstext::lower(&clean(path(state, &["scene", "scene_kind"]), 40));
    let both = format!("{from} {to}");
    let wilderness = scene_kind == "wilderness"
        || jstext::test(re!(r"(лес|тракт|дорог|пустош|болот|гор|ущель|перевал|пещер|road|forest|wild|marsh|mountain)", "iu"), &both);
    let grave = jstext::test(re!(r"(кладбищ|склеп|руин|grave|crypt|ruin)", "iu"), &both);
    TravelFacts {
        source: "legacy_text",
        band: ["near", "regional", "far"][(entropy % 3) as usize],
        wilderness,
        danger_risk: 0.0,
        theme_options: if grave {
            &["undead", "raiders"]
        } else if wilderness {
            &["beasts", "goblinoids", "raiders"]
        } else {
            &["raiders", "goblinoids"]
        },
        route_id: None,
        no_route: false,
    }
}

/// План пути (`planServerTravel`): длительность, риск и случайная стычка.
/// `options` — `{ campaignId, destination, destinationLocationId, idempotencyKey }`.
pub fn plan_server_travel(state: &Value, options: &Value) -> Value {
    let option = |key: &str| options.get(key);
    let graph = world_travel_graph(state);
    let scene_location = path(state, &["scene", "location"]);
    let origin = graph.as_ref().and_then(|graph| graph_location(graph, Some(&Value::String(graph.current_location_id.clone())), scene_location));
    let target = graph.as_ref().and_then(|graph| graph_location(graph, option("destinationLocationId"), option("destination")));
    let first = |candidates: [String; 2], fallback: String| candidates.into_iter().find(|text| !text.is_empty()).unwrap_or(fallback);
    let from = first([clean(scene_location, 180), clean(get(origin, "name"), 180)], "Текущая локация".to_string());
    let to = first([clean(option("destination"), 180), clean(get(target, "name"), 180)], format!("{from} — следующая сцена"));
    let chapter = chapter_of(state);
    let fingerprint = format!("{}:{}:{from}:{to}:{}", template(option("campaignId")), template(option("idempotencyKey")), js::f64_string(chapter));
    let entropy = hash_number(&fingerprint);
    let new_place = origin.is_some() && target.is_none();
    let facts = match (&graph, origin, target) {
        (Some(graph), Some(origin), Some(target)) => graph_travel_facts(graph, origin, target),
        _ if new_place => TravelFacts { source: "new_place", band: "near", ..legacy_text_travel_facts(state, &from, &to, entropy) },
        _ => legacy_text_travel_facts(state, &from, &to, entropy),
    };
    let duration = if new_place { NEW_PLACE_TRAVEL_MINUTES } else { travel_base_minutes(facts.band) + if facts.wilderness { 30 } else { 0 } };
    let tension = clamp(path(state, &["autonomy", "pacing", "tension"]), 0.0, 100.0);
    let pressure = if quests(state).iter().any(|quest| {
        is_str(get(Some(quest), "status"), "active")
            && js::number(path(quest, &["clock", "current"])) >= js_max(1.0, js::number(path(quest, &["clock", "max"])) - 2.0)
    }) {
        15.0
    } else {
        0.0
    };
    let after_encounter = recent_encounter_resolved(state);
    let discount = if after_encounter { 35.0 } else { 0.0 };
    let risk = clamp_f64(tension + if facts.wilderness { 20.0 } else { 5.0 } + pressure - discount + facts.danger_risk, 0.0, 100.0);
    let threshold = clamp_f64(risk - 35.0, 0.0, 55.0);
    let roll = ((entropy >> 8) % 100) as f64;
    let random_encounter = !after_encounter && risk >= 65.0 && roll < threshold;
    let theme = facts.theme_options[((entropy >> 16) % facts.theme_options.len() as u64) as usize];
    let difficulty = if risk >= 90.0 {
        "hard"
    } else if risk >= 72.0 {
        "medium"
    } else {
        "easy"
    };
    json!({
        "travel_id": format!("travel-{}", &hash::sha256_hex(&fingerprint)[..20]),
        "from": from,
        "to": to,
        "distance_band": facts.band,
        "duration_minutes": duration,
        "risk_score": js::num(risk),
        "random_encounter": random_encounter,
        "encounter": if random_encounter { json!({ "theme": theme, "difficulty": difficulty }) } else { Value::Null },
        "source": facts.source,
        "route_id": facts.route_id,
        "no_route": facts.no_route,
        "policy": "server-travel-v3",
    })
}

const NPC_NAMES: [&str; 6] = ["Арина Медный Лист", "Борен Серый Плащ", "Вея Тихая Река", "Гален Фонарщик", "Дара Каменная Пыль", "Еремей Следопыт"];
const NPC_ROLES: [&str; 6] = ["местный проводник", "очевидец", "хранитель дороги", "ремесленник", "посыльный", "исследователь руин"];

/// Собеседник, которого сервер приводит в социальную сцену
/// (`assembleSocialNpc`). `options` — `{ campaignId, requestedId, idempotencyKey }`.
pub fn assemble_social_npc(state: &Value, options: &Value) -> Value {
    let option = |key: &str| options.get(key);
    let location = clean(path(state, &["scene", "location"]), 180);
    let location = if location.is_empty() { "Текущая локация".to_string() } else { location };
    let campaign_id = template(option("campaignId"));
    let entropy = hash_number(&format!("{campaign_id}:{}:{location}:{}", template(option("idempotencyKey")), template(option("requestedId"))));
    let name = NPC_NAMES[(entropy % 6) as usize];
    let role = NPC_ROLES[((entropy >> 8) % 6) as usize];
    let generated_id = format!("npc-{}", &hash::sha256_hex(format!("{campaign_id}:{location}:{name}"))[..16]);
    let scene = state.get("scene");
    let location_id = match get(scene, "location_id") {
        None | Some(Value::Null) => get(scene, "locationId"),
        other => other,
    };
    let profile = json!({ "id": "assembled-npc", "name": name, "location": location, "location_id": clean(location_id, 120) });
    let known: Vec<String> = npc_witnessed_fact_ids(state, &profile).into_iter().filter(|id| !id.is_empty()).take(20).collect();
    let faction = array(path(state, &["worldMemory", "entities"])).iter().find(|entity| is_str(get(Some(entity), "kind"), "faction"));
    let requested = clean(option("requestedId"), 120);
    let taken = array(path(state, &["social", "npcs"])).iter().any(|npc| js::string(get(Some(npc), "id")) == requested);
    let faction_id = get(faction, "id");
    json!({
        "id": if !requested.is_empty() && !taken { requested } else { generated_id },
        "name": name,
        "role": role,
        "location": location,
        "public_summary": format!("{name} — {role}, которого можно встретить в локации «{location}»."),
        "voice": "Говорит ясно, отвечает только на то, что действительно знает.",
        "goals": ["Сохранить безопасность своей общины", "Понять намерения отряда"],
        "beliefs": ["Поступки важнее обещаний"],
        "known_fact_ids": known,
        "visibility": "party",
        "available": true,
        "tags": if js::truthy(faction_id) { vec![format!("faction:{}", clean(faction_id, 120))] } else { Vec::new() },
        "schedule": [],
        "inventory": [],
    })
}

/// Завершённый отдых отряда (`completedDowntime`). `options` —
/// `{ kind, durationMinutes, reason }`; отсутствующее поле — запас JS.
pub fn completed_downtime(state: &Value, options: &Value) -> Value {
    let kind = options.get("kind").cloned().unwrap_or_else(|| json!("long_rest"));
    let duration = options.get("durationMinutes").cloned().unwrap_or_else(|| json!(480));
    let reason = options.get("reason").cloned().unwrap_or_else(|| json!("post_encounter_recovery"));
    let party: HashSet<String> = array(state.get("partyMemberIds")).iter().map(|id| js::string(Some(id))).collect();
    let heroes = path(state, &["mechanics", "death", "heroes"]);
    let mut participants: Vec<Value> = array(state.get("players"))
        .iter()
        .filter(|hero| {
            let id = js::string(get(Some(hero), "id"));
            party.contains(&id) && !is_str(get(get(heroes, &id), "status"), "dead")
        })
        .map(|hero| Value::String(js::string(get(Some(hero), "id"))))
        .collect();
    js::default_sort(&mut participants);
    let mut seed = Map::new();
    let campaign = match state.get("sessionCode") {
        None | Some(Value::Null) => state.get("campaign_id"),
        other => other,
    };
    if let Some(campaign) = campaign {
        seed.insert("campaign".into(), campaign.clone());
    }
    if let Some(at) = path(state, &["mechanics", "world_time", "elapsed_minutes"]) {
        seed.insert("at".into(), at.clone());
    }
    seed.insert("participants".into(), Value::Array(participants.clone()));
    seed.insert("reason".into(), reason.clone());
    json!({
        "downtime_id": format!("downtime-{}", &hash::sha256_hex(js::stringify(&Value::Object(seed)))[..20]),
        "kind": kind,
        "duration_minutes": js::num(js_max(0.0, number_or(Some(&duration), 0.0))),
        "participant_ids": participants,
        "reason": clean(Some(&reason), 120),
        "policy": "server-downtime-v1",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_counts_utf16_units() {
        assert_eq!(head_utf16("a😀b", 2), "a");
        assert_eq!(head_utf16("a😀b", 3), "a😀");
    }

    #[test]
    fn affirmative_needs_direct_command() {
        assert!(affirmative_player_action(Some(&json!("Атакуем!")), "encounter"));
        assert!(!affirmative_player_action(Some(&json!("мы не нападаем")), "encounter"));
        assert!(!affirmative_player_action(Some(&json!("если что, атакуем")), "encounter"));
        assert!(affirmative_player_action(Some(&json!("продолжить подтверждённый переход")), "transition"));
        assert!(!affirmative_player_action(Some(&json!("уйти")), "other"));
    }
}

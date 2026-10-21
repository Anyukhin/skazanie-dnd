//! Перенос `server/director-agent.mjs`: Режиссёр — темп, развилки, переходы.
//!
//! Модель предлагает ограниченное намерение (контракт `autonomous-campaign`,
//! `DIRECTOR_INTENT_TYPES`); сервер проверяет его тем же
//! `normalizeDirectorIntent`. Без модели, при её отказе и на прямой просьбе
//! отряда (бой, переход) работает серверная политика
//! [`fallback_director_intent`]. Системный промпт выбирается режимом
//! импровизации кампании: `story` — `prompts/director/v4_story.txt`, `chaos` —
//! `prompts/director/v4_chaos.txt`.
//!
//! Клиент модели внедряется ([`RoleClient`]): роль не знает, RouterAI это,
//! каскад или заглушка.

use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_core::{js, text};
use sk_agents_base::llm_client::LlmClient;
use sk_world_story::autonomous_campaign::{normalize_director_intent, DirectorIntentError};

use crate::hero_hooks::party_motives_for_director;

const STORY_PROMPT: &str = include_str!("../../../../prompts/director/v4_story.txt");
const CHAOS_PROMPT: &str = include_str!("../../../../prompts/director/v4_chaos.txt");

/// Вариант контракта Режиссёра по режиму импровизации: `(id, текст)`.
pub fn director_prompt(improv_mode: &str) -> (&'static str, &'static str) {
    if improv_mode == "chaos" {
        ("director/v4_chaos", CHAOS_PROMPT)
    } else {
        ("director/v4_story", STORY_PROMPT)
    }
}

/// `DIRECTOR_MEMORY_RECORD_LIMIT`.
pub const DIRECTOR_MEMORY_RECORD_LIMIT: i64 = 6;
const DIRECTOR_THREAD_LIMIT: usize = 6;
const DIRECTOR_PROMISE_LIMIT: usize = 6;

// ---------------------------------------------------------------------------
// Внедрённый клиент модели
// ---------------------------------------------------------------------------

/// Клиент модели, внедрённый в роль (`new Role({ llmClient })`), и имя его
/// класса JS (`llmClient.constructor.name`), которое роли пишут в `provider`:
/// `MeteredLLMClient`, `FallbackLLMClient`, `FakeLLM`.
#[derive(Clone)]
pub struct RoleClient {
    client: Arc<dyn LlmClient>,
    class_name: String,
}

impl RoleClient {
    pub fn new(client: Arc<dyn LlmClient>, class_name: impl Into<String>) -> Self {
        RoleClient { client, class_name: class_name.into() }
    }

    pub fn client(&self) -> &dyn LlmClient {
        self.client.as_ref()
    }

    /// `llmClient.constructor?.name ?? 'llm'`.
    pub fn class_name(&self) -> &str {
        if self.class_name.is_empty() {
            "llm"
        } else {
            &self.class_name
        }
    }

    /// `llmClient.model ?? null`.
    pub fn model_value(&self) -> Value {
        self.client.model().map_or(Value::Null, Value::String)
    }
}

impl std::fmt::Debug for RoleClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("RoleClient").field("class_name", &self.class_name).finish()
    }
}

// ---------------------------------------------------------------------------
// Приведения JS
// ---------------------------------------------------------------------------

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value?, |current, key| get(Some(current), key))
}

fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn coalesce<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        Some(value) if !value.is_null() => Some(value),
        _ => second,
    }
}

fn is_str(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        _ => false,
    }
}

fn head_utf16(source: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in source.chars() {
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
    head_utf16(&text::squash_spaces(&text::nfkc(&js::s(value))), maximum)
}

/// `Number(x) || fallback`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if number == 0.0 || number.is_nan() {
        fallback
    } else {
        number
    }
}

/// `Math.max(a, b)` с `NaN`, как в JS.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `arr.slice(-n)`.
fn last_n(items: &[Value], n: usize) -> &[Value] {
    &items[items.len().saturating_sub(n)..]
}

fn clock_brief(clock: Option<&Value>, triggered: bool) -> Value {
    if !js::truthy(clock) {
        return Value::Null;
    }
    let mut result = Map::new();
    result.insert("current".into(), js::num(number_or(get(clock, "current"), 0.0)));
    result.insert("max".into(), js::num(number_or(get(clock, "max"), 1.0)));
    if triggered {
        result.insert("triggered".into(), Value::Bool(js::is_true(get(clock, "triggered"))));
    }
    Value::Object(result)
}

// ---------------------------------------------------------------------------
// Бриф
// ---------------------------------------------------------------------------

fn selection_fields(target: &mut Map<String, Value>, metadata: &Value, prefix: &str) {
    for key in ["scope", "status", "availability", "complete_within_scope"] {
        if let Some(value) = metadata.get(key) {
            target.insert(format!("{prefix}_{key}"), value.clone());
        }
    }
    if js::truthy(metadata.get("truncation_reason")) {
        target.insert(format!("{prefix}_truncation_reason"), metadata["truncation_reason"].clone());
    }
}

/// Внимание главного противника для брифа: счёт, пороги и стадия незнакомца.
fn director_attention_brief(attention: &Value) -> Value {
    let mut result = Map::new();
    for (to, from) in [("value", "value"), ("stranger_at", "stranger_at"), ("ready_at", "ready_at"), ("dragon_ready", "ready"), ("stranger", "stranger_stage")] {
        if let Some(value) = attention.get(from) {
            result.insert(to.into(), value.clone());
        }
    }
    Value::Object(result)
}

/// «Этаж: {подпись}; известные этажи: {список}» — пусто у одноэтажной локации.
fn scene_level_line(state: &Value) -> String {
    let level = path(Some(state), &["scene", "level"]);
    if !matches!(level, Some(Value::Object(_) | Value::Array(_))) {
        return String::new();
    }
    let location_id = js::s(coalesce(
        coalesce(path(Some(state), &["scene", "location_id"]), path(Some(state), &["scene", "locationId"])),
        path(Some(state), &["worldMap", "currentLocationId"]),
    ));
    let known: Vec<String> =
        array(get(get(Some(state), "locationLevels"), &location_id)).iter().map(|entry| clean(get(Some(entry), "label"), 120)).filter(|label| !label.is_empty()).collect();
    let label = {
        let label = clean(get(level, "label"), 120);
        if label.is_empty() {
            format!("этаж {}", js::f64_string(number_or(get(level, "index"), 0.0)))
        } else {
            label
        }
    };
    if known.is_empty() {
        format!("Этаж: {label}")
    } else {
        format!("Этаж: {label}; известные этажи: {}", known.join(", "))
    }
}

fn current_chapter_history(state: &Value) -> Vec<&Value> {
    let intents: Vec<&Value> = array(path(Some(state), &["autonomy", "director_history"]))
        .iter()
        .map(|entry| coalesce(get(Some(entry), "intent"), None).unwrap_or(entry))
        .filter(|entry| matches!(entry, Value::Object(_) | Value::Array(_)))
        .collect();
    let last_end = intents.iter().rposition(|intent| is_str(get(Some(intent), "type"), "end_scene"));
    match last_end {
        Some(index) => intents[index + 1..].to_vec(),
        None => intents,
    }
}

fn first_active_quest(state: &Value) -> Option<&Value> {
    array(path(Some(state), &["worldMemory", "quests"])).iter().find(|quest| is_str(get(Some(quest), "status"), "active") && !js::truthy(path(Some(quest), &["clock", "triggered"])))
}

fn first_available_npc(state: &Value) -> Option<&Value> {
    let location = text::lower(&clean(path(Some(state), &["scene", "location"]), 180));
    array(path(Some(state), &["social", "npcs"])).iter().find(|npc| {
        !js::is_false(get(Some(npc), "available"))
            && (!js::truthy(get(Some(npc), "location")) || location.is_empty() || text::lower(&clean(get(Some(npc), "location"), 180)) == location)
    })
}

fn director_memory_query(state: &Value, player_action: &str) -> String {
    let action = Value::String(player_action.to_string());
    let parts: Vec<String> = [
        Some(&action),
        path(Some(state), &["scene", "title"]),
        path(Some(state), &["scene", "location"]),
        path(Some(state), &["scene", "objective"]),
        path(Some(state), &["adventure", "currentHook"]),
    ]
    .into_iter()
    .filter(|value| js::truthy(*value))
    .map(js::s)
    .collect();
    head_utf16(&parts.join(" "), 3_000)
}

fn director_memory_record(record: &Value) -> Value {
    let record = Some(record);
    let mut result = Map::new();
    result.insert("kind".into(), Value::String(clean(get(record, "kind"), 40)));
    result.insert("id".into(), Value::String(clean(get(record, "id"), 120)));
    result.insert("summary".into(), Value::String(clean(get(record, "summary"), 360)));
    if is_str(get(record, "kind"), "fact") && js::truthy(get(record, "fact")) {
        let name = path(record, &["entity", "name"]);
        let subject = if js::truthy(name) { name } else { path(record, &["fact", "subject_id"]) };
        result.insert("subject".into(), Value::String(clean(subject, 120)));
        result.insert("predicate".into(), Value::String(clean(path(record, &["fact", "predicate"]), 100)));
    }
    if js::truthy(get(record, "thread")) {
        result.insert("status".into(), Value::String(clean(path(record, &["thread", "status"]), 30)));
        result.insert("clock".into(), clock_brief(path(record, &["thread", "clock"]), true));
    }
    if js::truthy(get(record, "quest")) {
        result.insert("status".into(), Value::String(clean(path(record, &["quest", "status"]), 30)));
    }
    if js::truthy(get(record, "claim")) {
        result.insert("truth_status".into(), Value::String(clean(path(record, &["claim", "truth_status"]), 30)));
        result.insert("claim_kind".into(), Value::String(clean(path(record, &["claim", "kind"]), 30)));
    }
    Value::Object(result)
}

fn director_narrative_memory(state: &Value, player_action: &str, viewer: &Value) -> Value {
    let mut options = Map::new();
    options.insert("query".into(), Value::String(director_memory_query(state, player_action)));
    options.insert("limit".into(), Value::from(DIRECTOR_MEMORY_RECORD_LIMIT));
    if let Some(minutes) = path(Some(state), &["mechanics", "world_time", "elapsed_minutes"]) {
        options.insert("asOfMinutes".into(), minutes.clone());
    }
    let records: Vec<Value> = sk_memory::world_memory::retrieve_world_memory(get(Some(state), "worldMemory").unwrap_or(&Value::Null), viewer, &Value::Object(options))
        .iter()
        .map(director_memory_record)
        .collect();
    let open_threads: Vec<Value> = array(path(Some(state), &["worldMemory", "threads"]))
        .iter()
        .filter(|thread| is_str(get(Some(thread), "status"), "active"))
        .take(DIRECTOR_THREAD_LIMIT)
        .map(|thread| {
            let thread = Some(thread);
            json!({
                "id": clean(get(thread, "id"), 120), "title": clean(get(thread, "title"), 160), "summary": clean(get(thread, "summary"), 360),
                "clock": clock_brief(get(thread, "clock"), true),
            })
        })
        .collect();
    let closed: Vec<&Value> = array(path(Some(state), &["social", "promises"])).iter().filter(|promise| !is_str(get(Some(promise), "status"), "open")).collect();
    let promise_consequences: Vec<Value> = closed[closed.len().saturating_sub(DIRECTOR_PROMISE_LIMIT)..]
        .iter()
        .map(|promise| {
            let promise = Some(*promise);
            json!({
                "id": clean(get(promise, "id"), 120), "npc_id": clean(get(promise, "npc_id"), 120), "hero_id": clean(get(promise, "hero_id"), 120),
                "direction": clean(get(promise, "direction"), 40), "text": clean(get(promise, "text"), 300), "status": clean(get(promise, "status"), 30),
                "resolution_reason": clean(get(promise, "resolution_reason"), 30), "consequence_delta": js::num(number_or(get(promise, "consequence_delta"), 0.0)),
            })
        })
        .collect();
    json!({ "retrieved": records, "open_threads": open_threads, "promise_consequences": promise_consequences })
}

/// Место следующей сцены без модели: соседняя точка карты мира, а у кампании
/// без карты мира — «След N».
fn next_scene_destination(state: &Value) -> String {
    if let Some(destination) = sk_story::campaign_loop_policy::next_world_map_destination(state) {
        return destination;
    }
    let chapter = path(Some(state), &["adventure", "chapter"]);
    let chapter = if js::truthy(chapter) { js::number(chapter) } else { 1.0 };
    format!("След {}", js::f64_string(js_max(2.0, chapter + 1.0)))
}

/// `fallbackDirectorIntent(state, playerAction)`: серверная политика темпа,
/// когда модели нет или её ответ негоден.
pub fn fallback_director_intent(state: &Value, player_action: &str) -> Result<Value, DirectorIntentError> {
    use sk_story::campaign_loop_policy as policy;
    let action = Value::String(player_action.to_string());
    let chapter_history = current_chapter_history(state);
    let has_type = |kind: &str| chapter_history.iter().any(|intent| is_str(get(Some(intent), "type"), kind));
    let quest = first_active_quest(state);
    let abandoned_quests = policy::abandoned_quests_for_director(state);
    let next_objective = policy::director_objective_after_quest_abandonment(state, None);
    let npc = first_available_npc(state);
    let arc = policy::campaign_arc_position(state);
    let is_final = js::truthy(arc.as_ref().and_then(|arc| arc.get("is_final")));
    let encounter = path(Some(state), &["mechanics", "encounter"]);
    let outcomes = array(path(Some(state), &["autonomy", "encounter_outcomes"]));
    let encounter_id = get(encounter, "id");
    let outcome_recorded = js::truthy(encounter_id) && outcomes.iter().any(|entry| strict_eq(get(Some(entry), "encounter_id"), encounter_id));
    let ended = is_str(get(encounter, "status"), "ended");
    if (!js::truthy(encounter) || ended) && policy::affirmative_player_action(Some(&action), "encounter") {
        return policy::scenario_encounter_intent(
            state,
            &json!({ "type": "request_encounter", "theme": "beasts", "difficulty": if is_final { "hard" } else { "medium" }, "reason": "Игрок явно запросил столкновение; сервер проверит и соберёт встречу." }),
        );
    }
    if !js::truthy(path(Some(state), &["mechanics", "combat", "active"])) && policy::affirmative_player_action(Some(&action), "transition") {
        return normalize_director_intent(Some(&json!({ "type": "end_scene", "destination": next_scene_destination(state), "reason": "Игрок явно подтвердил переход после разрешённого столкновения." })));
    }
    if ended && outcome_recorded && !has_type("end_scene") {
        return normalize_director_intent(Some(&json!({
            "type": "end_scene",
            "destination": next_scene_destination(state),
            "reason": "Последствия столкновения подтверждены сервером; история переходит к следующей связанной сцене.",
        })));
    }
    if !has_type("continue_exploration") {
        return normalize_director_intent(Some(&json!({ "type": "continue_exploration", "reason": "Сначала отряд исследует текущую сцену." })));
    }
    if !has_type("open_social_scene") {
        if let Some(npc) = npc {
            return normalize_director_intent(Some(&json!({ "type": "open_social_scene", "npc_id": get(Some(npc), "id").cloned().unwrap_or(Value::Null), "reason": "Доступный очевидец связывает исследование с квестом." })));
        }
    }
    if !has_type("advance_quest_clock") {
        if let Some(quest) = quest {
            if policy::confirmed_quest_progress(state, &js::s(get(Some(quest), "id"))) {
                return normalize_director_intent(Some(&json!({ "type": "advance_quest_clock", "quest_id": get(Some(quest), "id").cloned().unwrap_or(Value::Null), "reason": "Подтверждённая зацепка продвигает активную цель." })));
            }
        }
    }
    if is_final && quest.is_none() && abandoned_quests.is_empty() && !has_type("resolve_scene") {
        return normalize_director_intent(Some(&json!({
            "type": "resolve_scene",
            "resolution": "decision",
            "reason": "Сервер предлагает подтвердить достигнутую цель; завершение требует отдельного решения игроков.",
        })));
    }
    let hook = |fallback: &str| if next_objective.is_empty() { fallback.to_string() } else { next_objective.clone() };
    if !has_type("request_encounter") && !js::truthy(encounter) {
        let reason = if abandoned_quests.is_empty() { "Мир предлагает следующую угрозу или альтернативный путь без обязательного боя." } else { "После отказа Директор предлагает выбрать новое занятие в текущей локации." };
        return normalize_director_intent(Some(&json!({ "type": "offer_next_hook", "hook": hook(sk_memory::world_memory::QUEST_ABANDONMENT_NEXT_OBJECTIVE), "reason": reason })));
    }
    if ended && !has_type("end_scene") {
        let reason = if abandoned_quests.is_empty() { "Сервер ещё применяет последствия столкновения." } else { "После отказа Директор сохраняет место и предлагает новую цель." };
        return normalize_director_intent(Some(&json!({ "type": "offer_next_hook", "hook": hook("Осмыслить последствия столкновения"), "reason": reason })));
    }
    let reason = if abandoned_quests.is_empty() { "Сохраняется доступная сюжетная зацепка." } else { "Оставленное задание не возвращается; требуется новый следующий шаг." };
    normalize_director_intent(Some(&json!({ "type": "offer_next_hook", "hook": hook("Продолжить расследование"), "reason": reason })))
}

/// `publicDirectorBrief(state, playerAction, contractVersion)`: бриф
/// Режиссёра. Он не зависит от личного знания одного героя или скрытого
/// результата квеста.
pub fn public_director_brief(state: &Value, player_action: &str, contract_version: &str) -> Value {
    use sk_encounters::agent_context::{agent_context_metadata, bounded_selection_metadata, campaign_concept_for_agent, AgentContextOptions, SelectionOptions};
    let party_viewer = json!({ "isPartyMember": true });
    let visible_state = sk_society::quest_consequences::quest_state_for_viewer(state, &party_viewer);
    let visible = Some(&visible_state);
    let arc = sk_story::campaign_loop_policy::campaign_arc_position(&visible_state);
    let level_line = scene_level_line(&visible_state);
    let active_candidates: Vec<&Value> = array(path(visible, &["worldMemory", "quests"])).iter().filter(|quest| is_str(get(Some(quest), "status"), "active")).collect();
    let social = sk_social::npc_social::npc_social_for_viewer(
        path(visible, &["social"]).unwrap_or(&Value::Null),
        &json!({ "state": visible_state.clone(), "isPartyMember": true }),
    );
    let public_promises: Vec<Value> = array(path(visible, &["social", "promises"]))
        .iter()
        .filter(|promise| !js::truthy(get(Some(promise), "visibility")) || is_str(get(Some(promise), "visibility"), "party"))
        .cloned()
        .collect();
    let mut public_state = visible_state.as_object().cloned().unwrap_or_default();
    let mut public_social = social.as_object().cloned().unwrap_or_default();
    public_social.insert("promises".into(), Value::Array(public_promises));
    public_state.insert("social".into(), Value::Object(public_social));
    let public_state = Value::Object(public_state);
    let current_id = clean(coalesce(path(visible, &["scene", "location_id"]), path(visible, &["scene", "locationId"])), 120);
    let scene_location = text::lower(&clean(path(visible, &["scene", "location"]), 160));
    let npc_candidates: Vec<&Value> = array(social.get("npcs"))
        .iter()
        .filter(|npc| {
            if js::is_false(get(Some(npc), "available")) {
                return false;
            }
            let npc_location_id = clean(coalesce(get(Some(npc), "location_id"), get(Some(npc), "locationId")), 120);
            if !current_id.is_empty() && !npc_location_id.is_empty() {
                return current_id == npc_location_id;
            }
            text::lower(&clean(get(Some(npc), "location"), 160)) == scene_location
        })
        .collect();
    let role = Value::from("director");
    let contract = Value::from(contract_version);
    let actor = coalesce(get(visible, "activePlayerId"), None).cloned().unwrap_or(Value::Null);
    let metadata = agent_context_metadata(&visible_state, &AgentContextOptions { role: Some(&role), actor_id: Some(&actor), target_id: None, contract_version: Some(&contract) });

    let mut scene = Map::new();
    scene.insert("title".into(), Value::String(clean(path(visible, &["scene", "title"]), 100)));
    scene.insert("location".into(), Value::String(clean(path(visible, &["scene", "location"]), 160)));
    scene.insert("objective".into(), Value::String(clean(path(visible, &["scene", "objective"]), 240)));
    scene.insert("turn".into(), js::num(number_or(path(visible, &["scene", "turn"]), 0.0)));
    if !level_line.is_empty() {
        scene.insert("level".into(), Value::String(level_line));
    }
    let mut world = Map::new();
    world.insert("campaign_premise".into(), campaign_concept_for_agent(&visible_state, None));
    world.insert("scene".into(), Value::Object(scene));
    world.insert("chapter".into(), js::num(js_max(1.0, number_or(path(visible, &["adventure", "chapter"]), 1.0))));
    world.insert("world_clock".into(), sk_world_time::weather::world_clock_for_agents(&visible_state, None));
    let phase = clean(path(visible, &["autonomy", "pacing", "phase"]), 30);
    world.insert(
        "pacing".into(),
        json!({
            "phase": if phase.is_empty() { "breather".to_string() } else { phase },
            "tension": js::num(js_max(0.0, js_min(100.0, number_or(path(visible, &["autonomy", "pacing", "tension"]), 0.0)))),
            "beat": js::num(js_max(0.0, number_or(path(visible, &["autonomy", "pacing", "beat"]), 0.0))),
        }),
    );
    if let Some(arc) = arc.as_ref() {
        let mut brief = Map::new();
        for (to, from) in [
            ("preset", "preset"),
            ("scene_number", "scene_number"),
            ("target_scenes", "target_scenes"),
            ("scene_beat", "scene_beat"),
            ("remaining_beats", "remaining_beats"),
            ("phase", "phase"),
            ("climax_required", "climax"),
        ] {
            if let Some(value) = arc.get(from) {
                brief.insert(to.into(), value.clone());
            }
        }
        world.insert("arc".into(), Value::Object(brief));
    }
    if let Some(story) = sk_scenario::campaign_scenario::scenario_director_brief(&visible_state) {
        let mut story = story.as_object().cloned().unwrap_or_default();
        if let Some(attention) = sk_attention::scenario_attention::scenario_attention(state) {
            story.insert("attention".into(), director_attention_brief(&attention));
        }
        world.insert("story".into(), Value::Object(story));
    }
    let active_quests: Vec<Value> = active_candidates
        .iter()
        .take(12)
        .map(|quest| {
            let quest = Some(*quest);
            let objectives: Vec<Value> = array(get(quest, "objectives")).iter().map(|item| Value::String(clean(Some(item), 180))).take(8).collect();
            json!({ "id": clean(get(quest, "id"), 120), "title": clean(get(quest, "title"), 160), "objectives": objectives, "clock": clock_brief(get(quest, "clock"), false) })
        })
        .collect();
    world.insert("active_quests".into(), Value::Array(active_quests));
    let scope = Value::from("party_visible_active_quests");
    let count = Value::from(active_candidates.len());
    let limit = Value::from(12);
    selection_fields(&mut world, &bounded_selection_metadata(&SelectionOptions { scope: Some(&scope), candidate_count: Some(&count), limit: Some(&limit), source_available: None }), "active_quests");
    world.insert("abandoned_quests".into(), Value::Array(sk_story::campaign_loop_policy::abandoned_quests_for_director(&visible_state)));
    world.insert(
        "quest_policy".into(),
        json!({ "never_reopen_abandoned": true, "next_objective_after_abandonment": sk_story::campaign_loop_policy::director_objective_after_quest_abandonment(&visible_state, None) }),
    );
    let available: Vec<Value> = npc_candidates
        .iter()
        .take(12)
        .map(|npc| {
            let npc_value = Some(*npc);
            let id = get(npc_value, "id").cloned().unwrap_or(Value::Null);
            json!({
                "id": clean(get(npc_value, "id"), 120), "name": clean(get(npc_value, "name"), 120), "role": clean(get(npc_value, "role"), 120), "location": clean(get(npc_value, "location"), 160),
                "combat_ready": sk_npc_world::npc_positioning::npc_mechanics_for(&visible_state, &id).is_some_and(|mechanics| js::truthy(Some(&mechanics))),
            })
        })
        .collect();
    world.insert("available_npcs".into(), Value::Array(available));
    let scope = Value::from("party_visible_available_npcs_in_current_location");
    let count = Value::from(npc_candidates.len());
    selection_fields(&mut world, &bounded_selection_metadata(&SelectionOptions { scope: Some(&scope), candidate_count: Some(&count), limit: Some(&limit), source_available: None }), "available_npcs");
    let encounter = path(visible, &["mechanics", "encounter"]);
    world.insert(
        "encounter".into(),
        if js::truthy(encounter) { json!({ "status": clean(get(encounter, "status"), 40), "outcome": clean(get(encounter, "outcome"), 80) }) } else { Value::Null },
    );
    let motives: Vec<Value> =
        party_motives_for_director(state).into_iter().map(|entry| json!({ "hero": entry.hero, "motive": entry.motive, "unrevealed_hook_leads": entry.unrevealed_hook_leads })).collect();
    world.insert("party_motives".into(), Value::Array(motives));
    world.insert("narrative_memory".into(), director_narrative_memory(&public_state, player_action, &party_viewer));

    let history = current_chapter_history(&visible_state);
    let recent_events: Vec<Value> = history[history.len().saturating_sub(12)..]
        .iter()
        .map(|intent| json!({ "type": clean(get(Some(intent), "type"), 40), "reason": clean(get(Some(intent), "reason"), 180) }))
        .collect();
    let recent_outcomes: Vec<Value> = last_n(array(path(visible, &["autonomy", "director_outcomes"])), 12)
        .iter()
        .map(|outcome| json!({ "intent_type": clean(get(Some(outcome), "intent_type"), 40), "state_changed": js::is_true(get(Some(outcome), "state_changed")) }))
        .collect();
    let action = {
        let action = clean(Some(&Value::String(player_action.to_string())), 500);
        if action.is_empty() {
            "Продолжить приключение".to_string()
        } else {
            action
        }
    };
    json!({
        "context_metadata": metadata,
        "WORLD_STATE": Value::Object(world),
        "RECENT_EVENTS": recent_events,
        "RECENT_OUTCOMES": recent_outcomes,
        "PLAYER_ACTION": action,
        "UNTRUSTED_DATA": true,
    })
}

/// Итог [`DirectorAgent::choose`]: `{ intent, trace }`.
pub type DirectorChoice = Value;

/// `DirectorAgent`: темп, развилки, переходы.
#[derive(Clone, Debug, Default)]
pub struct DirectorAgent {
    llm_client: Option<RoleClient>,
}

impl DirectorAgent {
    /// `new DirectorAgent({ llmClient })`.
    pub fn new(llm_client: Option<RoleClient>) -> Self {
        DirectorAgent { llm_client }
    }

    /// Запрос к модели (`{ messages, temperature, maxTokens, role, jsonSchema }`),
    /// который отправил бы [`Self::choose`].
    pub fn model_request(state: &Value, player_action: &str, improv_mode: &str) -> Value {
        let (prompt_id, prompt_text) = director_prompt(improv_mode);
        json!({
            "messages": [
                { "role": "system", "content": prompt_text },
                { "role": "user", "content": sk_tactics::security::build_data_only_context(Some(&json!({ "director_brief": public_director_brief(state, player_action, prompt_id) }))) },
            ],
            "temperature": 0.25,
            "maxTokens": 500,
            // Творческая роль: профиль рассуждений лидера кампании её касается.
            "role": "director",
            // Форма ответа на стороне провайдера; normalizeDirectorIntent всё равно проверяет.
            "jsonSchema": &*sk_story::llm_json_schemas::DIRECTOR_INTENT_JSON_SCHEMA,
        })
    }

    /// `choose({ state, playerAction, improvMode })`: `improv_mode` `None` —
    /// режим текущей кампании (`currentImprovMode()`). `story` — мягкий
    /// возврат к главной линии, `chaos` — перестройка арки вокруг действий
    /// отряда; запасная политика от режима не зависит. Отказ серверной
    /// политики ([`fallback_director_intent`]) — ошибка, как исключение JS.
    pub async fn choose(&self, state: &Value, player_action: &str, improv_mode: Option<&Value>) -> Result<DirectorChoice, DirectorIntentError> {
        let improv = match improv_mode {
            Some(mode) => sk_narration_base::campaign_ai_context::normalize_improv_mode(Some(mode)).to_string(),
            None => {
                let current = Value::String(sk_narration_base::campaign_ai_context::current_improv_mode());
                sk_narration_base::campaign_ai_context::normalize_improv_mode(Some(&current)).to_string()
            }
        };
        let (prompt_id, _) = director_prompt(&improv);
        let role = Value::from("director");
        let contract = Value::from(prompt_id);
        let actor = coalesce(get(Some(state), "activePlayerId"), None).cloned().unwrap_or(Value::Null);
        let context_metadata = sk_encounters::agent_context::agent_context_metadata(
            state,
            &sk_encounters::agent_context::AgentContextOptions { role: Some(&role), actor_id: Some(&actor), target_id: None, contract_version: Some(&contract) },
        );
        let fallback = fallback_director_intent(state, player_action)?;
        let trace = |mode: &str, tail: (&str, Value)| {
            let mut trace = Map::new();
            trace.insert("agent".into(), Value::from("DirectorAgent"));
            trace.insert("mode".into(), Value::from(mode));
            trace.insert("improv_mode".into(), Value::from(improv.as_str()));
            trace.insert("prompt_id".into(), Value::from(prompt_id));
            trace.insert("context_metadata".into(), context_metadata.clone());
            trace.insert(tail.0.into(), tail.1);
            Value::Object(trace)
        };
        let fallback_type = fallback.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        if fallback_type == "request_encounter" {
            return Ok(json!({ "intent": fallback, "trace": trace("deterministic-explicit-player-request", ("reason", Value::from("explicit combat request"))) }));
        }
        // Прямая просьба отряда уйти дальше — решение игроков, а не модели.
        if fallback_type == "end_scene" && sk_story::campaign_loop_policy::affirmative_player_action(Some(&Value::String(player_action.to_string())), "transition") {
            return Ok(json!({ "intent": fallback, "trace": trace("deterministic-explicit-player-request", ("reason", Value::from("explicit transition request"))) }));
        }
        let Some(client) = self.llm_client.as_ref() else {
            return Ok(json!({ "intent": fallback, "trace": trace("deterministic-fallback", ("reason", Value::from("LLM is not configured"))) }));
        };
        let input = Self::model_request(state, player_action, &improv);
        let outcome = match client.client().complete_json(&input, &json!({ "timeoutMs": 12_000 })).await {
            Ok(result) => normalize_director_intent(Some(&result)).map_err(|error| error.message),
            Err(error) => Err(error.message),
        };
        Ok(match outcome {
            Ok(intent) => json!({ "intent": intent, "trace": trace("model", ("model", client.model_value())) }),
            Err(message) => json!({ "intent": fallback, "trace": trace("deterministic-fallback", ("reason", Value::String(message))) }),
        })
    }
}


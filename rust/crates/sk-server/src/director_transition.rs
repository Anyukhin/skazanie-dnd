//! С18.5: переходы сцены Режиссёра и соло-выход (`server/index.mjs:2925–2961,
//! 3022–3094, 3127–3352`).
//!
//! - [`execute_party_decision_tool`] — `executeTool('request_party_decision', …)`
//!   (2925–2956): карточка решения отряда в `effects.interaction`. Ветка
//!   `advance_scene` того же `executeTool` в JS ни один маршрут не зовёт —
//!   она не перенесена;
//! - [`execute_director_scene_transition`] — переход сцены по решённому
//!   голосованию: очередь на решение (`serializeDirectorDecision`), отказ
//!   повторного потребления (`PARTY_DECISION_ALREADY_CONSUMED`), архитектор
//!   сцены, сводка покидаемой сцены, пакет серверных команд Режиссёра и
//!   `gameOrchestrator.handle` с меткой Режиссёра;
//! - [`replay_director_scene_transition`] — повтор по ключу без модели;
//! - [`execute_solo_party_exit`] — соло-стол: решение открывается и сразу
//!   решается одним голосом, затем тот же переход.
//!
//! Всё — в задании ядра: журнал синхронно, аккаунты — через [`blocking`].
//! Очередь на решение — асинхронный замок ядра на ключ решения: ожидание
//! модели архитектора держит только этот ключ, а не ядро и не кампанию.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_agents::player_request_router::{party_option_label, resolve_party_decision, PARTY_OPTION_LIMIT};
use sk_agents::scene_architect::PlanRequest;
use sk_core::{hash, js, text};
use sk_director::director_scene_transition::{assert_director_transition_result, build_director_transition_commands, resolved_party_decision_reference, DirectorTransitionError, DirectorTransitionInput};
use sk_orchestrator::game_orchestrator::HandleInput;
use sk_scenario::party_exit_intent::{abandonable_quest, classify_party_decision};
use sk_store::executor::{AuthoritativeExecutor, DerivedRequest, Producer};

use crate::core::{blocking, GameCore};
use crate::error::Failure;
use crate::orchestration::Orchestration;
use crate::projection::{executor_failure, latest_campaign_state, HookedJournal};
use crate::state::AppState;

fn transition_failure(error: DirectorTransitionError) -> Failure {
    Failure::new(error.message, error.code.as_deref())
}

pub(crate) fn orchestrator_failure(error: sk_orchestrator::autonomous_orchestrator::OrchestratorError) -> Failure {
    Failure::new(error.message(), error.code())
}

/// `commandPolicyError(message, code)`.
pub(crate) fn policy_error(message: &str, code: &str) -> Failure {
    Failure::new(message, Some(code))
}

/// `{ roll: null, reveal: [], spawn: [], objective: null, grantItems: [], scene: null, interaction: null }`.
pub fn empty_effects() -> Value {
    json!({ "roll": null, "reveal": [], "spawn": [], "objective": null, "grantItems": [], "scene": null, "interaction": null })
}

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

/// `String(value || '')`.
fn or_empty(value: Option<&Value>) -> String {
    if js::truthy(value) {
        js::s(value)
    } else {
        String::new()
    }
}

/// Объект JS-литерала: поля `undefined` (`None`) в JSON не попадают.
fn literal(entries: Vec<(&str, Option<Value>)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        if let Some(value) = value {
            map.insert(key.to_string(), value);
        }
    }
    Value::Object(map)
}

// --- executeTool('request_party_decision') ----------------------------------

/// `executeTool('request_party_decision', args, effects, state)` (2926–2953):
/// записывает карточку в `effects.interaction` и возвращает итог инструмента.
pub fn execute_party_decision_tool(args: &Value, effects: &mut Value, state: &Value) -> Value {
    if js::truthy(effects.get("interaction")) {
        return json!({ "error": "Одновременно разрешено только одно активное решение группы" });
    }
    let options: Vec<Value> = args
        .get("options")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .enumerate()
        .map(|(index, option)| json!({ "id": format!("option-{}", index + 1), "label": party_option_label(Some(option), PARTY_OPTION_LIMIT) }))
        .filter(|option| option.get("label").and_then(Value::as_str).is_some_and(|label| !label.is_empty()))
        .take(4)
        .collect();
    if options.len() < 2 {
        return json!({ "error": "Для решения нужны хотя бы два варианта" });
    }
    let destination_source = match args.get("destinationLocationId").filter(|value| !value.is_null()) {
        Some(value) => Some(value),
        None => args.get("destination_location_id").filter(|value| !value.is_null()),
    };
    let destination_location_id = text::head(&text::squash_spaces(&text::nfkc(&js::s(destination_source))), 120);
    // Идентификатор обычно случайный: карточку открывает живой ход, и повтор
    // её не воспроизводит. Соло-путь передаёт свой — выведенный из ключа
    // идемпотентности, — иначе повтор одного запроса открыл бы второе решение.
    let given_id = text::head(text::trim(&js::s(args.get("interactionId"))), 120);
    let id = if given_id.is_empty() { hash::uuid_v4() } else { given_id };
    let kind = match args.get("type").and_then(Value::as_str) {
        Some(kind @ ("vote" | "roll" | "choice")) => kind.to_string(),
        _ => "vote".to_string(),
    };
    let title = {
        let raw = if js::truthy(args.get("title")) { js::s(args.get("title")) } else { "Решение отряда".to_string() };
        text::head(&text::squash_spaces(&raw), 100)
    };
    let description = text::head(&text::squash_spaces(&or_empty(args.get("description"))), 360);
    let mut interaction = Map::new();
    interaction.insert("id".into(), Value::String(id));
    interaction.insert("type".into(), Value::String(kind));
    interaction.insert("title".into(), Value::String(title));
    interaction.insert("description".into(), Value::String(description));
    interaction.insert("options".into(), Value::Array(options));
    interaction.insert("votes".into(), json!({}));
    interaction.insert("status".into(), Value::String("open".into()));
    // `difficulty: args.type === 'roll' ? … : undefined`.
    if args.get("type").and_then(Value::as_str) == Some("roll") {
        let requested = js::number(args.get("difficulty"));
        let difficulty = if requested.is_nan() || requested == 0.0 { 12.0 } else { requested };
        interaction.insert("difficulty".into(), js::num(difficulty.min(25.0).max(5.0)));
    }
    interaction.insert("resolutionPrompt".into(), Value::String(text::head(&text::squash_spaces(&or_empty(args.get("resolutionPrompt"))), 360)));
    if !destination_location_id.is_empty() {
        interaction.insert("destinationLocationId".into(), Value::String(destination_location_id));
    }
    interaction.insert("createdAt".into(), Value::from(sk_core::clock::now_ms()));
    // `policy: state.partyDecisionPolicy` (`undefined` в JSON не попадает).
    if let Some(policy) = state.get("partyDecisionPolicy") {
        interaction.insert("policy".into(), policy.clone());
    }
    let interaction = Value::Object(interaction);
    if let Some(map) = effects.as_object_mut() {
        map.insert("interaction".into(), interaction.clone());
    }
    json!({ "opened": true, "interaction": interaction })
}

// --- очередь на решение группы ------------------------------------------------

thread_local! {
    /// `directorDecisionLocks` (3023): очередь заданий на одно решение.
    static DECISION_LOCKS: RefCell<HashMap<String, Rc<tokio::sync::Mutex<()>>>> = RefCell::new(HashMap::new());
}

/// `directorDecisionLockKey(campaignId, reference)` (3029–3037).
fn decision_lock_key(campaign_id: &str, reference: &Value) -> String {
    hash::sha256_hex(format!("{campaign_id}\0{}\0{}", js::s(reference.get("interaction_id")), js::s(reference.get("resolved_option_id"))))
}

/// Ход того же решения ждёт предыдущий (`serializeDirectorDecision`,
/// 3038–3050); освобождённый ключ без ожидающих уходит из карты.
struct DecisionTurn {
    key: String,
    lock: Rc<tokio::sync::Mutex<()>>,
}

impl Drop for DecisionTurn {
    fn drop(&mut self) {
        DECISION_LOCKS.with(|locks| {
            let mut locks = locks.borrow_mut();
            // Карта и этот ход — единственные владельцы: никто не ждёт.
            if locks.get(&self.key).is_some_and(|current| Rc::ptr_eq(current, &self.lock) && Rc::strong_count(current) <= 2) {
                locks.remove(&self.key);
            }
        });
    }
}

fn decision_turn(key: &str) -> DecisionTurn {
    let lock = DECISION_LOCKS.with(|locks| locks.borrow_mut().entry(key.to_string()).or_insert_with(|| Rc::new(tokio::sync::Mutex::new(()))).clone());
    DecisionTurn { key: key.to_string(), lock }
}

// --- журнал ------------------------------------------------------------------

fn is_scene_advanced(event: &Value) -> bool {
    event.get("event_type").and_then(Value::as_str) == Some("SceneAdvanced")
}

/// `committedSceneForPartyDecision(campaignId, reference)` (3053–3058).
fn committed_scene_for_party_decision(core: &GameCore, campaign_id: &str, reference: &Value) -> Result<Option<Value>, Failure> {
    // Ищется только `SceneAdvanced`: читаются одни такие события (урок 11).
    let events = core.events.get_events_of_types(campaign_id, &["SceneAdvanced"])?;
    let same = |event: &Value, field: &str| {
        let recorded = get(get(event.get("payload"), "party_decision"), field);
        match (recorded, reference.get(field)) {
            (Some(Value::String(left)), Some(Value::String(right))) => left == right,
            _ => false,
        }
    };
    Ok(events.into_iter().rev().find(|event| is_scene_advanced(event) && same(event, "interaction_id") && same(event, "resolved_option_id")))
}

/// `committedSceneForFingerprint(campaignId, fingerprint)` (3060–3064).
pub fn committed_scene_for_fingerprint(core: &GameCore, campaign_id: &str, fingerprint: &str) -> Result<Option<Value>, Failure> {
    let events = core.events.get_events_of_types(campaign_id, &["SceneAdvanced"])?;
    Ok(events.into_iter().rev().find(|event| is_scene_advanced(event) && get(event.get("payload"), "request_fingerprint").and_then(Value::as_str) == Some(fingerprint)))
}

// --- переход сцены ---------------------------------------------------------------

/// Вход переходов сцены (`{ campaignId, room, user, action, idempotencyKey,
/// resolution }` JS).
pub struct TransitionInput<'a> {
    pub core: &'a Rc<GameCore>,
    pub app: &'a Arc<AppState>,
    pub services: &'a Orchestration,
    pub campaign_id: &'a str,
    /// `room.state`.
    pub room_state: Value,
    pub user: &'a Value,
    pub action: &'a str,
    pub idempotency_key: &'a str,
    pub resolution: Value,
}

/// `campaignHeroIds(user, campaignId)` (аккаунты — через [`blocking`]).
pub async fn allowed_actor_ids(app: &Arc<AppState>, user: &Value, campaign_id: &str) -> Result<Value, Failure> {
    let accounts = app.accounts.clone();
    let (user, campaign) = (user.clone(), campaign_id.to_string());
    let ids = blocking(move || crate::access::campaign_hero_ids(&accounts, &user, &campaign)).await??;
    Ok(js::strings_value(ids))
}

/// `executeDirectorSceneTransition(input)` (3066–3077).
pub async fn execute_director_scene_transition(input: TransitionInput<'_>) -> Result<Value, Failure> {
    let source = match input.resolution.get("partyDecision").filter(|value| !value.is_null()) {
        Some(reference) => reference.clone(),
        None => input.room_state.clone(),
    };
    let party_decision = resolved_party_decision_reference(Some(&source), true).map_err(transition_failure)?.unwrap_or(Value::Null);
    let turn = decision_turn(&decision_lock_key(input.campaign_id, &party_decision));
    let outcome = async {
        let _queued = turn.lock.lock().await;
        if let Some(consumed) = committed_scene_for_party_decision(input.core, input.campaign_id, &party_decision)? {
            if js::string(consumed.get("idempotency_key")) != input.idempotency_key {
                return Err(policy_error("Это решение группы уже было исполнено переходом сцены", "PARTY_DECISION_ALREADY_CONSUMED"));
            }
        }
        execute_director_scene_transition_once(input, party_decision).await
    }
    .await;
    // Ход отпустил очередь: без ожидающих ключ уходит из карты.
    drop(turn);
    outcome
}

/// Поля перехода из `SceneAdvanced` (`{ scene, adventure, worldMap,
/// transition, arrival, entrance }`; отсутствующее поле в JSON не попадает).
fn committed_transition(payload: &Value) -> Value {
    literal(["scene", "adventure", "worldMap", "transition", "arrival", "entrance"].iter().map(|key| (*key, payload.get(*key).cloned())).collect())
}

fn find_event<'a>(mechanics: Option<&'a Value>, event_type: &str) -> Option<&'a Value> {
    mechanics.and_then(Value::as_array)?.iter().find(|event| event.get("event_type").and_then(Value::as_str) == Some(event_type))
}

/// `committedTransition.scene?.cells?.length ?? 0`.
fn cell_count(transition: &Value) -> Value {
    match get(transition.get("scene"), "cells") {
        Some(Value::Array(cells)) => Value::from(cells.len()),
        Some(Value::String(text)) => Value::from(text.encode_utf16().count()),
        _ => Value::from(0),
    }
}

/// `{ ...result, effects: { ...result.effects, scene }, turn_consumed: true, action_kind: 'world', … }`.
fn with_transition(result: &Value, transition: Value, extra: Vec<(&str, Value)>) -> Value {
    let effects = js::spread(result.get("effects").filter(|value| value.is_object()).unwrap_or(&json!({})), json!({ "scene": transition }));
    let mut patch = Map::new();
    patch.insert("effects".into(), effects);
    patch.insert("turn_consumed".into(), Value::Bool(true));
    patch.insert("action_kind".into(), Value::String("world".into()));
    for (key, value) in extra {
        patch.insert(key.into(), value);
    }
    js::spread(result, Value::Object(patch))
}

/// `executeDirectorSceneTransitionOnce` (3195–3283).
async fn execute_director_scene_transition_once(input: TransitionInput<'_>, party_decision: Value) -> Result<Value, Failure> {
    let TransitionInput { core, app, services, campaign_id, room_state, user, action, idempotency_key, resolution } = input;
    let authoritative = latest_campaign_state(core, campaign_id, Some(&room_state))?;
    let planning_state = sk_rules::normalize::normalize_campaign_state(&authoritative)?;
    let decision = js::s(resolution.get("decision"));
    let canonical_decision_action = format!("[РЕШЕНИЕ ГРУППЫ] {}", text::head(&text::squash_spaces(&decision), 500));
    let request = PlanRequest {
        action: canonical_decision_action,
        decision: decision.clone(),
        destination_hint: js::s(resolution.get("destinationHint")),
        destination_location_id: js::s(resolution.get("destinationLocationId")),
        abandons_quest: resolution.get("abandonsQuest") == Some(&Value::Bool(true)),
    };
    let planned = services.scene_architect.plan(&planning_state, &request).await;
    // Считаем только живую генерацию: детерминированный fallback токенов не
    // тратит. Лимита нет — на пересечении порога стол получает одну строку.
    if get(planned.get("trace"), "mode").and_then(Value::as_str) == Some("model") {
        let usage = app.architect_usage.clone();
        let campaign = campaign_id.to_string();
        let counted = blocking(move || usage.record_generation(&campaign)).await?.map_err(|error| Failure::new(error.to_string(), None))?;
        if counted.alert {
            let alert = json!({
                "id": format!("architect-alert-{campaign_id}-{}", counted.day),
                "speaker": "system",
                "author": "Расход кампании",
                "text": sk_agents_base::architect_usage::architect_alert_text(counted.generations),
            });
            crate::journal::append_room_journal(core, campaign_id, &[alert])?;
        }
    }
    // Сводка пишется о сцене, которую отряд ПОКИДАЕТ (`campaignEventsForSummary`:
    // сбой чтения журнала — пустой список).
    // Сводке нужны только события после последнего `SceneAdvanced`
    // (`eventsSinceSceneStart`): читается хвост журнала, а не весь (урок 11).
    let events = core.events.get_events_since_last(campaign_id, "SceneAdvanced").unwrap_or_default();
    let summary_options = literal(vec![
        ("state", Some(planning_state.clone())),
        ("events", Some(Value::Array(events))),
        ("decision", resolution.get("decision").cloned()),
        ("destinationHint", resolution.get("destinationHint").cloned()),
        ("destination", get(planned.get("sceneArgs"), "location").cloned()),
    ]);
    let scene_summary = sk_narration::scene_summary::scene_summary_for(Some(&summary_options)).map_err(|error| Failure::new(error.0, None))?;
    // Какое задание закрывает отказ, решает сервер той же функцией, которой он
    // собирал подпись варианта.
    let abandon_quest = if resolution.get("abandonsQuest") == Some(&Value::Bool(true)) { abandonable_quest(&planning_state).map(|quest| json!({ "id": quest.id, "title": quest.title })) } else { None };
    let scene_args = match planned.get("sceneArgs") {
        Some(args) if !scene_summary.is_empty() => Some(js::spread(args, json!({ "scene_summary": scene_summary }))),
        Some(args) => Some(args.clone()),
        None if !scene_summary.is_empty() => Some(json!({ "scene_summary": scene_summary })),
        None => None,
    };
    let campaign_value = Value::String(campaign_id.to_string());
    let action_value = Value::String(action.to_string());
    let plan = build_director_transition_commands(DirectorTransitionInput {
        campaign_id: Some(&campaign_value),
        action: Some(&action_value),
        state: Some(&planning_state),
        scene_args: scene_args.as_ref(),
        shop_intent: planned.get("shopIntent"),
        party_decision: Some(&party_decision),
        abandon_quest: abandon_quest.as_ref(),
    })
    .map_err(transition_failure)?;
    let allowed = allowed_actor_ids(app, user, campaign_id).await?;
    let fields = json!({
        "state": planning_state,
        "campaignId": campaign_id,
        "playerId": or_empty(planning_state.get("activePlayerId")),
        "message": action,
        "commands": plan.get("commands").cloned().unwrap_or(Value::Null),
        "idempotencyKey": idempotency_key,
        "user": user,
        "allowedActorIds": allowed,
    });
    let result = services.game.handle(HandleInput { director_capability: true, ..HandleInput::new(fields) }).await.map_err(orchestrator_failure)?;
    assert_director_transition_result(Some(&result), plan.get("fingerprint")).map_err(transition_failure)?;
    let scene_event = find_event(result.get("mechanics"), "SceneAdvanced");
    let transition = match scene_event.and_then(|event| event.get("payload")).filter(|payload| js::truthy(Some(payload))) {
        Some(payload) => committed_transition(payload),
        None => plan.get("transition").cloned().unwrap_or(Value::Null),
    };
    let merchant_event = find_event(result.get("mechanics"), "MerchantCreated");
    let merchant_id = get(merchant_event.and_then(|event| event.get("payload")), "merchant_id").filter(|value| !value.is_null()).or_else(|| plan.get("existingMerchantId")).cloned();
    let shop_action = get(plan.get("shopIntent"), "action").cloned();
    let shop_outcome = if merchant_event.is_some() {
        "created"
    } else if js::truthy(plan.get("existingMerchantId")) {
        "reused"
    } else {
        "not-requested"
    };
    let abandoned_quest_id = result
        .get("mechanics")
        .and_then(Value::as_array)
        .and_then(|events| events.iter().find(|event| event.get("event_type").and_then(Value::as_str) == Some("QuestResolved") && get(event.get("payload"), "outcome").and_then(Value::as_str) == Some("abandoned")))
        .and_then(|event| get(event.get("payload"), "quest_id"))
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or(Value::Null);
    let director = literal(vec![
        ("fingerprint", plan.get("fingerprint").cloned()),
        ("shop_action", shop_action.clone()),
        ("shop_outcome", Some(Value::String(shop_outcome.into()))),
        ("merchant_id", merchant_id.clone()),
        ("abandoned_quest_id", Some(abandoned_quest_id)),
    ]);
    let trace = json!([
        { "agent": "AgentDirector", "output": resolution },
        planned.get("trace").cloned().unwrap_or(Value::Null),
        literal(vec![("agent", Some(json!("WorldEngine"))), ("output", Some(literal(vec![("event", Some(json!("SceneAdvanced"))), ("cells", Some(cell_count(&transition))), ("entrance", transition.get("entrance").cloned())])))]),
        literal(vec![("agent", Some(json!("ShopAssembler"))), ("output", Some(literal(vec![("action", shop_action), ("merchant_id", merchant_id)])))]),
    ]);
    Ok(with_transition(&result, transition, vec![("director_transition", director), ("agent_trace", trace)]))
}

/// Повтор перехода по ключу (`replayDirectorSceneTransition`, 3284–3330):
/// пустой план команд читает записанный пакет, архитектор и модель не нужны.
#[allow(clippy::too_many_arguments)]
pub async fn replay_director_scene_transition(core: &Rc<GameCore>, app: &Arc<AppState>, services: &Orchestration, campaign_id: &str, room_state: &Value, user: &Value, action: &str, idempotency_key: &str, duplicate: &sk_store::CommitResult, resolution: Value) -> Result<Value, Failure> {
    let _ = core;
    let allowed = allowed_actor_ids(app, user, campaign_id).await?;
    let fields = json!({
        "state": room_state,
        "campaignId": campaign_id,
        "playerId": or_empty(room_state.get("activePlayerId")),
        "message": action,
        "commands": [],
        "idempotencyKey": idempotency_key,
        "user": user,
        "allowedActorIds": allowed,
    });
    let result = services.game.handle(HandleInput { director_capability: true, ..HandleInput::new(fields) }).await.map_err(orchestrator_failure)?;
    let Some(payload) = find_event(result.get("mechanics"), "SceneAdvanced").and_then(|event| event.get("payload")).filter(|payload| js::truthy(Some(payload))) else {
        return Err(policy_error("Повтор перехода не содержит SceneAdvanced", "IDEMPOTENCY_CONFLICT"));
    };
    let transition = committed_transition(payload);
    let empty = json!({});
    let commerce = payload.get("scene_commerce").filter(|value| !value.is_null()).unwrap_or(&empty);
    let merchant_event = find_event(result.get("mechanics"), "MerchantCreated");
    let merchant_id = get(merchant_event.and_then(|event| event.get("payload")), "merchant_id")
        .filter(|value| !value.is_null())
        .or_else(|| commerce.get("merchant_id").filter(|value| !value.is_null()))
        .cloned()
        .unwrap_or(Value::Null);
    let shop_action = commerce.get("action").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!("none"));
    let shop_outcome = commerce.get("outcome").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!(if merchant_event.is_some() { "created" } else { "not-requested" }));
    let director = literal(vec![
        ("fingerprint", payload.get("request_fingerprint").cloned()),
        ("shop_action", Some(shop_action.clone())),
        ("shop_outcome", Some(shop_outcome)),
        ("merchant_id", Some(merchant_id.clone())),
        ("replayed", Some(Value::Bool(true))),
    ]);
    let trace = json!([
        { "agent": "AgentDirector", "output": resolution },
        { "agent": "EventReplay", "output": { "idempotency_key": duplicate.idempotency_key, "state_version": duplicate.state_version } },
        literal(vec![("agent", Some(json!("WorldEngine"))), ("output", Some(literal(vec![("event", Some(json!("SceneAdvanced"))), ("cells", Some(cell_count(&transition))), ("entrance", transition.get("entrance").cloned())])))]),
        { "agent": "ShopAssembler", "output": { "action": shop_action, "merchant_id": merchant_id } },
    ]);
    Ok(with_transition(&result, transition, vec![("model", json!("event-replay")), ("director_transition", director), ("agent_trace", trace)]))
}

// --- соло-выход ------------------------------------------------------------------

/// Вход [`execute_solo_party_exit`].
pub struct SoloExitInput<'a> {
    pub core: &'a Rc<GameCore>,
    pub app: &'a Arc<AppState>,
    pub services: &'a Orchestration,
    pub campaign_id: &'a str,
    pub room_state: Value,
    pub user: &'a Value,
    pub action: &'a str,
    pub idempotency_key: &'a str,
    pub player_id: &'a str,
    pub proposal: &'a Value,
}

/// `executeSoloPartyExit` (3127–3193): соло-стол не голосует — решение
/// открывается и решается одним голосом героя, затем переход. `None` — путь
/// неприменим (уже открыто другое решение, кворум не сошёлся, вариант ухода
/// не опознан), и вызывающий открывает обычную карточку.
pub async fn execute_solo_party_exit(input: SoloExitInput<'_>) -> Result<Option<Value>, Failure> {
    let SoloExitInput { core, app, services, campaign_id, room_state, user, action, idempotency_key, player_id, proposal } = input;
    let interaction_id = format!("solo-exit-{}", text::head(&hash::sha256_hex(format!("{campaign_id}\0{idempotency_key}")), 24));
    let mut effects = empty_effects();
    let args = js::spread(proposal, json!({ "interactionId": interaction_id }));
    execute_party_decision_tool(&args, &mut effects, &room_state);
    let Some(interaction) = effects.get("interaction").filter(|value| js::truthy(Some(value))).cloned() else { return Ok(None) };
    let options = interaction.get("options").and_then(Value::as_array).cloned().unwrap_or_default();
    // Вариант опознаётся тем же словарём, которым он был составлен, а не позицией.
    let classified: Vec<(Value, sk_scenario::party_exit_intent::PartyDecision)> = options.iter().map(|option| (option.clone(), classify_party_decision(&js::s(option.get("label"))))).collect();
    let wants_abandon = classify_party_decision(action).abandons_quest;
    let chosen = (if wants_abandon { classified.iter().find(|(_, kind)| kind.kind == "move" && kind.abandons_quest) } else { None })
        .or_else(|| classified.iter().find(|(_, kind)| kind.kind == "move" && !kind.abandons_quest))
        .or_else(|| classified.iter().find(|(_, kind)| kind.kind == "move"));
    let Some((chosen, _)) = chosen.cloned() else { return Ok(None) };
    let chosen_id = js::s(chosen.get("id"));

    // Отказ записать решение не должен ронять ход: стол увидит обычную карточку.
    let memberships = {
        let accounts = app.accounts.clone();
        let campaign = campaign_id.to_string();
        blocking(move || accounts.list_campaign_memberships(&campaign)).await?
    };
    let committed = match memberships {
        Err(_) => None,
        Ok(memberships) => {
            let player = Value::String(player_id.to_string());
            let derive = |state: &Value, _loaded: &sk_store::Loaded| -> Result<Vec<Value>, sk_core::RuleError> {
                // Чужое открытое решение соло-путь не трогает.
                if js::truthy(state.get("agentInteraction")) {
                    return Ok(Vec::new());
                }
                let eligible = crate::access::party_hero_ids(state);
                let snapshot = crate::access::party_voter_snapshot_with(&memberships, campaign_id, state, &eligible);
                let mut decision_options = Map::new();
                decision_options.insert("eligibleHeroIds".into(), js::strings_value(eligible.clone()));
                decision_options.insert("eligibleVoterIds".into(), snapshot.get("eligibleVoterIds").cloned().unwrap_or(Value::Null));
                decision_options.insert("voterByHeroId".into(), snapshot.get("voterByHeroId").cloned().unwrap_or(Value::Null));
                if let Some(policy) = state.get("partyDecisionPolicy") {
                    decision_options.insert("policy".into(), policy.clone());
                }
                let rule = |error: sk_memory::party_decision::PartyDecisionError| sk_core::RuleError::new(error.code, error.message);
                let opened = sk_memory::party_decision::party_decision_opened_event(&interaction, Some(&player), &Value::Object(decision_options)).map_err(rule)?;
                let stamped = js::spread(&opened, json!({ "campaign_id": campaign_id, "event_id": format!("{interaction_id}:opened") }));
                let after_open = sk_rules::replay::apply_game_event(state, &stamped).map_err(|halt| sk_core::RuleError::new(halt.code().unwrap_or("ENGINE_FAULT").to_string(), halt.to_string()))?;
                let vote = json!({ "interactionId": interaction_id, "heroId": player_id, "optionId": chosen_id, "eligibleHeroIds": eligible });
                let voted = sk_memory::party_decision::resolve_party_vote(&after_open, &vote).map_err(rule)?;
                // Кворум обязан сойтись с одного голоса.
                if !js::truthy(voted.get("resolvedOptionId")) {
                    return Ok(Vec::new());
                }
                let mut events = vec![opened];
                events.extend(voted.get("events").and_then(Value::as_array).cloned().unwrap_or_default());
                Ok(events)
            };
            let key = format!("party-decision-solo:{interaction_id}");
            let journal = HookedJournal(&core.events);
            let executor = AuthoritativeExecutor::new(&journal);
            let request = DerivedRequest { campaign_id, idempotency_key: &key, events: None, derive_events: Some(&derive), producer: Some(Producer::PartyDecision), derived_from: Vec::new(), metadata: Value::Null, derive_metadata: None };
            executor.commit_derived(request).map_err(executor_failure).ok().flatten()
        }
    };
    let Some(committed) = committed else { return Ok(None) };

    // Разбор не зависит от того, что вернул коммит: повтор по ключу отдаёт
    // запись журнала, а не состояние.
    let mut resolved = Map::new();
    resolved.insert("id".into(), Value::String(interaction_id.clone()));
    resolved.insert("status".into(), Value::String("resolved".into()));
    resolved.insert("resolvedOptionId".into(), Value::String(chosen_id.clone()));
    resolved.insert("options".into(), Value::Array(options));
    if let Some(destination) = interaction.get("destinationLocationId").filter(|value| js::truthy(Some(value))) {
        resolved.insert("destinationLocationId".into(), destination.clone());
    }
    let decision_action = Value::String(format!("[РЕШЕНИЕ ГРУППЫ] {}", js::s(chosen.get("label"))));
    let Some(resolution) = resolve_party_decision(Some(&decision_action), &json!({ "agentInteraction": Value::Object(resolved) })) else { return Ok(None) };
    if resolution.get("type").and_then(Value::as_str) != Some("scene_request") {
        return Ok(None);
    }
    let state = if committed.commit.state.is_null() { room_state } else { Value::clone(&committed.commit.state) };
    let resolution = js::spread(&resolution, json!({ "partyDecision": { "interaction_id": interaction_id, "resolved_option_id": chosen_id } }));
    execute_director_scene_transition(TransitionInput { core, app, services, campaign_id, room_state: state, user, action, idempotency_key, resolution }).await.map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn party_decision_tool_like_js() {
        let mut effects = empty_effects();
        let args = json!({ "type": "roll", "title": "  Кубик\n решает ", "options": ["Идти", "", "Остаться", "Ждать", "Спать", "Петь"], "difficulty": "30", "interactionId": " solo-1 ", "destination_location_id": " loc  a " });
        let result = execute_party_decision_tool(&args, &mut effects, &json!({ "partyDecisionPolicy": null }));
        assert_eq!(result["opened"], true);
        let interaction = &effects["interaction"];
        assert_eq!(interaction["id"], "solo-1");
        assert_eq!(interaction["title"], "Кубик решает");
        assert_eq!(interaction["difficulty"], 25);
        assert_eq!(interaction["destinationLocationId"], "loc a");
        assert_eq!(interaction["policy"], Value::Null, "policy: null сохраняется");
        let ids: Vec<&str> = interaction["options"].as_array().map(|options| options.iter().filter_map(|option| option["id"].as_str()).collect()).unwrap_or_default();
        assert_eq!(ids, ["option-1", "option-3", "option-4", "option-5"], "индекс — из исходного списка, затем срез до четырёх");
        let keys: Vec<&String> = interaction.as_object().map(|map| map.keys().collect()).unwrap_or_default();
        assert_eq!(keys, ["id", "type", "title", "description", "options", "votes", "status", "difficulty", "resolutionPrompt", "destinationLocationId", "createdAt", "policy"]);
        let again = execute_party_decision_tool(&args, &mut effects, &json!({}));
        assert_eq!(again["error"], "Одновременно разрешено только одно активное решение группы");
        let mut vote = empty_effects();
        execute_party_decision_tool(&json!({ "options": ["Да", "Нет"] }), &mut vote, &json!({}));
        assert!(vote["interaction"].get("difficulty").is_none(), "difficulty: undefined не печатается");
        assert!(vote["interaction"].get("policy").is_none());
        assert_eq!(vote["interaction"]["type"], "vote");
        let mut single = empty_effects();
        assert_eq!(execute_party_decision_tool(&json!({ "options": ["Да"] }), &mut single, &json!({}))["error"], "Для решения нужны хотя бы два варианта");
        assert_eq!(single["interaction"], Value::Null);
    }
}

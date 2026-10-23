//! С18.1: `POST /api/campaigns/:id/commands` — `server/index.mjs:5530–5956`.
//!
//! Структурированные команды стола (бой, заклинания, предметы, отдых,
//! развитие, торговля, обыск, пленные, звери, стража, таверна, письма,
//! благословения, разговор): санитайзер игрока (С16) → атомарность пакета →
//! запреты серверных команд (`AdvanceScene`, `CreateEncounter`, жизненный
//! цикл торговца) → сверка повтора ключа → двухфазный ручной бросок
//! (`RollRegistry`) → `GameOrchestrator::handle` → продолжение боя → проекция
//! с летописью хода → критический момент рассказчика → ответ зрителю.
//!
//! Порядок шагов, тексты и коды — строка в строку с JS. Как и там:
//!
//! - `requireUser` стоит вне `try` (401 границы); комната, доступ и тело —
//!   уже внутри: их сбой идёт по таблице `catch` (без кода — 500
//!   `INTERNAL_ERROR` «Повторите запрос с тем же ключом», `STATE_VERSION_CONFLICT`
//!   и др. — 409, отказ прав — 403, прочее — 400);
//! - ранние ответы (`404`, `403`, `429`, `403 ACTOR_FORBIDDEN`) идут мимо
//!   `catch`;
//! - отказ обыска (409 или `LOOT_*`) несёт свежий список контейнеров,
//!   запись летописи о том, кто успел, и `state_version` комнаты;
//! - резерв броска (SEC-04) снимается по исходу: ход исполнен — бросок
//!   потреблён, отказ без коммита — бросок снова свободен.
//!
//! Аккаунты — только в [`blocking`] на стороне HTTP (членство, герои
//! кампании, доступ к комнате узнаются заранее и передаются в ядро
//! значениями — [`Caller`] с [`KnownMemberships`]); остальное — одно задание
//! ядра. Ожидание модели (черновик письма, ход оркестратора, критический
//! момент) не держит займов `RefCell` — ядро в это время исполняет чужие
//! задания, как цикл событий Node.
//!
//! Отклонения и долги:
//!
//! - **`combatTurnCoordinator.hold` — заглушка.** Координатора автохода
//!   (`CombatTurnCoordinator`, сборка 432–467) в ядре ещё нет (С17): нечего
//!   придерживать, ход врага по часам не идёт. С17 подключает удержание здесь
//!   (`hold` до шага «реплика в летописи», снятие в `finally`).
//! - **`settleCombatContinuation` (3352–3363)** перенесена здесь минимально
//!   ([`settle_combat_continuation`]): одна стадия `combat-continuation`
//!   координатора последствий — те же условия (`applies`: бой активен и нет
//!   перемирия; ключ — позиция боя) и тот же журнал отказа, но без
//!   `PostCommitCoordinator`, которого в ядре нет (С17 заменит вызовом
//!   координатора).
//! - `assertMerchantIdempotency`/`assertMerchantResultFingerprint` (1023,
//!   1241) — здесь, пока `merchant_guard.rs` (С14) пуст.

use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;

use axum::http::StatusCode;
use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::js;
use sk_orchestrator::autonomous_orchestrator::OrchestratorError;
use sk_orchestrator::game_orchestrator::HandleInput;
use sk_store::LoadOptions;
use sk_turns::npc_turn_scheduler::{run_npc_turn_scheduler, NpcController, SchedulerOptions};

use crate::access::{campaign_hero_values, can_access_room, require_user, string_or_empty};
use crate::command_fingerprints::{
    assert_character_build_result_fingerprint, assert_item_idempotency, assert_item_result_fingerprint, assert_loot_idempotency, assert_loot_result_fingerprint, assert_make_attack_idempotency, assert_make_attack_result_fingerprint, assert_npc_combat_idempotency,
    assert_npc_combat_result_fingerprint, assert_rest_idempotency, assert_rest_result_fingerprint, merchant_command_fingerprint, AuthorizeDuplicate,
};
use crate::command_guard::{
    assert_player_combat_actor_permission, combat_actor_for, command_type, expand_player_rest_command, loot_taken_record_for, normalize_make_attack_command, policy_error, sanitize_merchant_command, sanitize_player_beast_command, sanitize_player_blessing_command,
    sanitize_player_captive_command, sanitize_player_character_command, sanitize_player_combat_command, sanitize_player_dialogue_command, sanitize_player_item_command, sanitize_player_law_command, sanitize_player_letter_command, sanitize_player_loot_command,
    sanitize_player_npc_combat_command, sanitize_player_pickpocket_command, sanitize_player_rest_command, sanitize_player_tavern_command, with_courier_reply_draft, Caller, GuardResult, Memberships, SocialCourierModel, ADMIN_MERCHANT_LIFECYCLE_COMMANDS,
    LOOT_STALE_ERROR_CODES, PLAYER_BEAST_COMMANDS, PLAYER_BLESSING_COMMANDS, PLAYER_CAPTIVE_COMMANDS, PLAYER_CHARACTER_COMMANDS, PLAYER_CHARACTER_LIFECYCLE_COMMANDS, PLAYER_COMBAT_COMMANDS, PLAYER_DIALOGUE_COMMANDS, PLAYER_ITEM_COMMANDS, PLAYER_LAW_COMMANDS,
    PLAYER_LETTER_COMMANDS, PLAYER_LOOT_COMMANDS, PLAYER_MERCHANT_COMMANDS, PLAYER_NPC_COMBAT_COMMANDS, PLAYER_PICKPOCKET_COMMANDS, PLAYER_REST_COMMANDS, PLAYER_TAVERN_COMMANDS, SERVER_ENCOUNTER_COMMANDS, SERVER_WORLD_COMMANDS,
};
use crate::core::{blocking, CoreError, GameCore};
use crate::dispatch::{Matcher, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, Failure};
use crate::http::json;
use crate::idempotency::key_or_uuid;
use crate::journal::{append_room_journal, combat_message_id, merchant_message_id, narration_message_id, player_message_id, player_note_author, player_note_from, recent_narrator_texts};
use crate::orchestration::{orchestration, Orchestration};
use crate::projection::{latest_campaign_state, persist_authoritative_projection, PersistOptions};
use crate::room::{get_room, Room};
use crate::startup::{finish_failed_roll_reservation, RollReservation};
use crate::state::AppState;

pub fn routes() -> Vec<Route> {
    // `parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/commands$/)` и `POST` (5530–5531).
    vec![Route::post(5530, Matcher::path_template("/api/campaigns/{id}/commands"), campaign_commands)]
}

/// Коды сбоя хранилища, на которые `catch` отвечает 500 (5922).
const INTERNAL_CODES: &[&str] = &["EIO", "ENOSPC", "CORRUPT_EVENT_LOG", "CAMPAIGN_RECOVERY_REQUIRED", "INVALID_STORE_FILE"];
/// Коды 409 (5924).
const CONFLICT_CODES: &[&str] = &["STATE_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "ENCOUNTER_ALREADY_PRESENT", "ENCOUNTER_DURING_COMBAT"];
/// Коды 403 (5925).
const FORBIDDEN_CODES: &[&str] = &["ACTOR_FORBIDDEN", "PLAYER_COMMAND_FORBIDDEN"];
/// Текст 500 маршрута (5944).
const INTERNAL_MESSAGE: &str = "Внутренняя ошибка сервера. Повторите запрос с тем же ключом.";
/// Текст отказа владельца героя (5588, 5641).
const ACTOR_FORBIDDEN_MESSAGE: &str = "Команда доступна только владельцу героя или его призванного существа";

fn is_admin(user: &Value) -> bool {
    user.get("role").and_then(Value::as_str) == Some("admin")
}

fn has(set: &[&str], kind: &str) -> bool {
    set.contains(&kind)
}

/// Поле объекта (у не-объекта полей нет).
fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

/// `a ?? b`.
fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        Some(value) if !value.is_null() => Some(value),
        _ => b,
    }
}

/// `String(command?.actor_id ?? command?.actorId ?? '')`.
fn actor_of(command: &Value) -> String {
    js::s(nullish(get(Some(command), "actor_id"), get(Some(command), "actorId")))
}

fn array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn of_type<'a>(commands: &'a [Value], set: &[&str]) -> Vec<&'a Value> {
    commands.iter().filter(|command| has(set, &command_type(command))).collect()
}

fn core_failure(error: CoreError) -> Failure {
    Failure::new(error.to_string(), None)
}

fn orchestrator_failure(error: OrchestratorError) -> Failure {
    Failure::new(error.message(), error.code())
}

// --- членство, узнанное заранее ---------------------------------------------

/// Ответы `campaignHasMemberships` для кампаний запроса (код пути и
/// `sessionCode` комнаты), узнанные в [`blocking`] до задания ядра.
pub struct KnownMemberships(Vec<(String, bool)>);

impl Memberships for KnownMemberships {
    fn campaign_has_memberships(&self, campaign_id: &str) -> GuardResult<bool> {
        let wanted = campaign_id.to_uppercase();
        Ok(self.0.iter().find(|(code, _)| *code == wanted).is_some_and(|(_, known)| *known))
    }
}

// --- торговля (1023–1030, 1241–1246) -----------------------------------------

/// Отпечатки торговых событий: `new Set(events.map(e => e.payload?.request_fingerprint).filter(Boolean).map(String))`.
fn merchant_fingerprints(events: Option<&Value>) -> IndexSet<String> {
    array(events).iter().map(|event| get(get(Some(event), "payload"), "request_fingerprint")).filter(|value| js::truthy(*value)).map(js::string).collect()
}

/// `assertMerchantIdempotency(campaignId, key, command)` (1023–1030).
fn assert_merchant_idempotency(core: &GameCore, campaign_id: &str, idempotency_key: &str, command: &Value) -> Result<(), Failure> {
    let Some(duplicate) = core.events.get_by_idempotency_key(campaign_id, idempotency_key)? else { return Ok(()) };
    let fingerprints = merchant_fingerprints(Some(&Value::Array(duplicate.events)));
    if fingerprints.len() != 1 || !fingerprints.contains(&merchant_command_fingerprint(command)) {
        return Err(policy_error("Этот ключ идемпотентности уже использован для другой торговой операции", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

/// `assertMerchantResultFingerprint(result, command)` (1241–1246).
fn assert_merchant_result_fingerprint(result: &Value, command: &Value) -> Result<(), Failure> {
    let fingerprints = merchant_fingerprints(get(Some(result), "mechanics"));
    if fingerprints.len() != 1 || !fingerprints.contains(&merchant_command_fingerprint(command)) {
        return Err(policy_error("Конкурирующая операция использовала тот же ключ идемпотентности", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

// --- продолжение боя (3352–3363) ---------------------------------------------

/// `settleCombatContinuation(campaignId, { advanceNpc })`: стадия
/// `combat-continuation` координатора последствий — ходы NPC до хода героя.
/// Стадия не применима (боя нет, перемирие, нет позиции) или упала —
/// `{ turns: [], events: [] }`; упавшая пишет в журнал процесса, как
/// `onError` координатора (375–377).
async fn settle_combat_continuation(core: &GameCore, set: &Orchestration, campaign_id: &str, advance_npc: bool) -> Result<Vec<Value>, Failure> {
    let loaded = core.events.load(campaign_id, &LoadOptions::default())?;
    let state = &loaded.state;
    let active = js::truthy(get(get(get(Some(state), "mechanics"), "combat"), "active"));
    if !active || sk_society::parley::truce_holds(state) || sk_society::post_commit_coordinator::combat_position_key(state).is_none() {
        return Ok(Vec::new());
    }
    let controller: &dyn NpcController = &set.npc_controller;
    let mut options = SchedulerOptions::new(campaign_id, set.journal.as_ref(), set.rules.as_ref());
    options.npc_controller = Some(controller);
    options.advance_npc = advance_npc;
    match run_npc_turn_scheduler(options).await {
        Ok(result) => Ok(result.turns),
        Err(error) => {
            eprintln!("[Сказание] Стадия combat-continuation после коммита не выполнена: {error}");
            Ok(Vec::new())
        }
    }
}

// --- маршрут -----------------------------------------------------------------

/// Что узнано на стороне HTTP до задания ядра.
struct Admitted {
    campaign_id: String,
    user: Value,
    body: Value,
    room: Room,
    idempotency_key: String,
    memberships: KnownMemberships,
    /// `campaignHeroIds(user, campaignId)`.
    hero_ids: Vec<Value>,
}

/// Отказ из `try`: ошибка для `catch` или готовый ранний ответ.
enum Stop {
    Thrown(Failure),
    Reply(StatusCode, Value),
}

impl From<Failure> for Stop {
    fn from(failure: Failure) -> Self {
        Stop::Thrown(failure)
    }
}

impl From<sk_store::StoreError> for Stop {
    fn from(error: sk_store::StoreError) -> Self {
        Stop::Thrown(Failure::from(error))
    }
}

impl From<CoreError> for Stop {
    fn from(error: CoreError) -> Self {
        Stop::Thrown(core_failure(error))
    }
}

/// Состояние `catch`: кто просил обыск и какой резерв броска держит запрос.
#[derive(Default)]
struct Pending {
    loot_actor_id: String,
    loot_container_id: String,
    reservation: Option<RollReservation>,
}

fn campaign_commands(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let user = require_user(ctx).await?;
        let campaign_id = ctx.param(0).to_string();
        let admitted = match admit(ctx, &campaign_id, user.clone()).await {
            Ok(admitted) => admitted,
            Err(Stop::Reply(status, body)) => return Ok(json(status, &body)),
            Err(Stop::Thrown(failure)) => {
                let state = ctx.state.clone();
                let (status, body) = state.core.call(move |core| Box::pin(async move { catch_reply(&core, &campaign_id, &user, Pending::default(), failure) })).await.map_err(ApiError::from)??;
                return Ok(json(status, &body));
            }
        };
        let state = ctx.state.clone();
        let (status, body) = ctx.state.core.call(move |core| Box::pin(async move { run(core, state, admitted).await })).await.map_err(ApiError::from)??;
        Ok(json(status, &body))
    })
}

/// Шаги `try` до первого чтения журнала (5545–5548): комната, доступ, тело;
/// заодно — членство и герои кампании для санитайзеров.
async fn admit(ctx: &mut RouteCtx, campaign_id: &str, user: Value) -> Result<Admitted, Stop> {
    let state = ctx.state.clone();
    let code = campaign_id.to_string();
    let room = state.core.call(move |core| Box::pin(async move { get_room(&core, &code) })).await??;
    if room.state.is_none() {
        return Err(Stop::Reply(StatusCode::NOT_FOUND, json!({ "error": "Кампания не найдена" })));
    }
    let accounts = state.accounts.clone();
    let (checked_user, checked_room) = (user.clone(), room.clone());
    if !blocking(move || can_access_room(&accounts, Some(&checked_user), &checked_room)).await?? {
        return Err(Stop::Reply(StatusCode::FORBIDDEN, json!({ "error": "Нет доступа к этой кампании" })));
    }
    let body = ctx.json_body().await.map_err(|error| Failure::new(error.message, Some(error.code)))?;
    let idempotency_key = key_or_uuid(&body, &ctx.headers);
    let session_code = string_or_empty(room.state.as_ref().and_then(|state| state.get("sessionCode")));
    let accounts = state.accounts.clone();
    let (checked_user, code) = (user.clone(), campaign_id.to_string());
    let (memberships, hero_ids) = blocking(move || -> Result<(KnownMemberships, Vec<Value>), Failure> {
        let mut known = Vec::new();
        for candidate in [code.clone(), session_code] {
            let upper = candidate.to_uppercase();
            if sk_core::text::trim(&candidate).is_empty() || known.iter().any(|(seen, _): &(String, bool)| *seen == upper) {
                continue;
            }
            known.push((upper, accounts.campaign_has_memberships(&candidate)?));
        }
        let hero_ids = campaign_hero_values(&accounts, &checked_user, &code)?;
        Ok((KnownMemberships(known), hero_ids))
    })
    .await??;
    Ok(Admitted { campaign_id: campaign_id.to_string(), user, body, room, idempotency_key, memberships, hero_ids })
}

/// Задание ядра: весь `try`, `catch` и `finally` маршрута.
async fn run(core: Rc<GameCore>, state: Arc<AppState>, admitted: Admitted) -> Result<(StatusCode, Value), ApiError> {
    let mut pending = Pending::default();
    let campaign_id = admitted.campaign_id.clone();
    let user = admitted.user.clone();
    let outcome = execute(&core, &state, &admitted, &mut pending).await;
    // `finally`: удержание автохода снимается всегда (С17; сейчас удерживать нечего).
    match outcome {
        Ok(reply) => Ok(reply),
        Err(Stop::Reply(status, body)) => Ok((status, body)),
        Err(Stop::Thrown(failure)) => catch_reply(&core, &campaign_id, &user, pending, failure),
    }
}

/// `catch (error)` (5920–5952).
fn catch_reply(core: &Rc<GameCore>, campaign_id: &str, user: &Value, pending: Pending, failure: Failure) -> Result<(StatusCode, Value), ApiError> {
    finish_failed_roll_reservation(core, pending.reservation.as_ref(), failure.code.as_deref());
    let code = failure.code.clone().unwrap_or_default();
    // `!error?.code`: пустой код — тоже внутренний сбой.
    let internal = code.is_empty() || has(INTERNAL_CODES, &code);
    let status = if internal {
        StatusCode::INTERNAL_SERVER_ERROR
    } else if has(CONFLICT_CODES, &code) {
        StatusCode::CONFLICT
    } else if has(FORBIDDEN_CODES, &code) {
        StatusCode::FORBIDDEN
    } else {
        StatusCode::BAD_REQUEST
    };
    let stale_loot = status == StatusCode::CONFLICT || has(LOOT_STALE_ERROR_CODES, &code);
    let stale_room_state = if stale_loot && !pending.loot_actor_id.is_empty() { get_room(core, campaign_id)?.state } else { None };
    let fresh_loot = match &stale_room_state {
        Some(room_state) => {
            let viewer = Value::String(pending.loot_actor_id.clone());
            let admin = Value::Bool(is_admin(user));
            Some(sk_director::loot_containers::loot_containers_for_viewer(room_state, Some(&viewer), Some(&admin)).map_err(|error| ApiError::internal(error.to_string()))?)
        }
        None => None,
    };
    let mut body = Map::new();
    body.insert("error".into(), Value::String(if internal { INTERNAL_MESSAGE.to_string() } else { failure.message.clone() }));
    if internal {
        body.insert("code".into(), Value::String("INTERNAL_ERROR".into()));
    } else if let Some(code) = &failure.code {
        body.insert("code".into(), Value::String(code.clone()));
    }
    if let (Some(fresh), Some(room_state)) = (fresh_loot, &stale_room_state) {
        body.insert("loot_containers".into(), fresh);
        let container = Value::String(pending.loot_container_id.clone());
        if let Some(record) = loot_taken_record_for(room_state, Some(&container)) {
            body.insert("loot_taken".into(), record);
        }
        let version = nullish(room_state.get("state_version"), None).cloned().unwrap_or(Value::from(0));
        body.insert("state_version".into(), js::num(js::number(Some(&version))));
    }
    if internal {
        eprintln!("[Сказание] Команда кампании {campaign_id} не выполнена: {failure}");
    }
    Ok((status, Value::Object(body)))
}

/// `{ ...value, key: v }` для объекта; у не-объекта — как есть.
fn spread_with(value: &Value, key: &str, item: Value) -> Value {
    let mut copy = value.clone();
    if let Some(map) = copy.as_object_mut() {
        map.insert(key.into(), item);
    }
    copy
}

/// Тело `try` (5545–5919).
async fn execute(core: &Rc<GameCore>, state: &Arc<AppState>, admitted: &Admitted, pending: &mut Pending) -> Result<(StatusCode, Value), Stop> {
    let campaign_id = admitted.campaign_id.as_str();
    let user = &admitted.user;
    let body = &admitted.body;
    let room = &admitted.room;
    let room_state = room.state.clone().unwrap_or(Value::Null);
    let idempotency_key = admitted.idempotency_key.as_str();
    let caller = Caller::new(user, &admitted.memberships);
    let admin = caller.is_admin();

    let mut commands: Vec<Value> = match body.get("commands") {
        Some(Value::Array(items)) => items.clone(),
        _ => match body.get("command") {
            Some(command) if js::truthy(Some(command)) => vec![command.clone()],
            _ => Vec::new(),
        },
    };
    if commands.is_empty() {
        return Err(Stop::Reply(StatusCode::BAD_REQUEST, json!({ "error": "Нужна command или commands" })));
    }
    if let Some(loot) = commands.iter().find(|command| has(PLAYER_LOOT_COMMANDS, &command_type(command))) {
        pending.loot_actor_id = actor_of(loot);
        let container = js::s(nullish(get(Some(loot), "container_id"), get(Some(loot), "containerId")));
        pending.loot_container_id = sk_core::text::slice(&container, 0, Some(120));
    }
    let before = latest_campaign_state(core, campaign_id, room.state.as_ref())?;

    // Вход в бой с NPC — отдельная атомарная команда (5558–5563).
    let requested_npc_combat = of_type(&commands, PLAYER_NPC_COMBAT_COMMANDS).len();
    if requested_npc_combat > 0 && commands.len() != 1 {
        return Err(policy_error("Вход в бой с NPC должен быть отдельной атомарной командой", "PLAYER_COMMAND_FORBIDDEN").into());
    }
    let mut preflight_npc_combat = Vec::new();
    for command in of_type(&commands, PLAYER_NPC_COMBAT_COMMANDS) {
        preflight_npc_combat.push(crate::command_guard::sanitize_player_npc_combat_command(&caller, &before, command)?);
    }
    if let Some(first) = preflight_npc_combat.first() {
        assert_npc_combat_idempotency(core.events.as_ref(), campaign_id, idempotency_key, first)?;
    }

    // Атаки не смешиваются с другими командами (5564–5567).
    let requested_attacks: Vec<Value> = of_type(&commands, &["MakeAttack"]).into_iter().cloned().collect();
    if !requested_attacks.is_empty() && requested_attacks.len() != commands.len() {
        return Err(policy_error("Атаки нельзя смешивать с другими командами в одном атомарном batch", "PLAYER_COMMAND_FORBIDDEN").into());
    }
    // Повтор атаки ищется до проверки текущей цели: исчезнувший призыв
    // авторизуется по связи с хозяином из сохранённого состояния (5568–5595).
    let mut historical_actors: HashSet<String> = HashSet::new();
    let mut preflight_attacks = Vec::new();
    for command in &requested_attacks {
        let actor = nullish(get(Some(command), "actor_id"), get(Some(command), "actorId"));
        preflight_attacks.push(if admin {
            normalize_make_attack_command(command, None)?
        } else if combat_actor_for(&before, actor)?.is_some() {
            sanitize_player_combat_command(&caller, &before, command, true)?
        } else {
            normalize_make_attack_command(command, None)?
        });
    }
    let is_attack_replay = if preflight_attacks.is_empty() {
        false
    } else {
        let mut authorize = |duplicate: &Value| -> GuardResult<()> {
            let historical_state = get(Some(duplicate), "state").cloned().unwrap_or(Value::Null);
            for command in &requested_attacks {
                let actor = Value::String(actor_of(command));
                if combat_actor_for(&before, Some(&actor))?.is_some() {
                    continue;
                }
                let historical = combat_actor_for(&historical_state, Some(&actor))?;
                if !historical.is_some_and(sk_core::game::is_party_summon) {
                    return Err(policy_error(ACTOR_FORBIDDEN_MESSAGE, "ACTOR_FORBIDDEN"));
                }
                assert_player_combat_actor_permission(&caller, &historical_state, command)?;
                historical_actors.insert(actor_of(command));
            }
            Ok(())
        };
        let authorize: Option<&mut AuthorizeDuplicate<'_>> = if admin { None } else { Some(&mut authorize) };
        assert_make_attack_idempotency(core.events.as_ref(), campaign_id, idempotency_key, &preflight_attacks, authorize)?
    };

    // Отдых — одной семантической командой (5596–5599).
    if !of_type(&commands, PLAYER_REST_COMMANDS).is_empty() && commands.len() != 1 {
        return Err(policy_error("Отдых принимается одной семантической командой", "PLAYER_COMMAND_FORBIDDEN").into());
    }
    let mut sanitized = Vec::with_capacity(commands.len());
    for command in &commands {
        let kind = command_type(command);
        let kind = kind.as_str();
        sanitized.push(if has(PLAYER_REST_COMMANDS, kind) {
            sanitize_player_rest_command(&caller, &before, command)?
        } else if has(PLAYER_MERCHANT_COMMANDS, kind) {
            sanitize_merchant_command(&caller, &before, command, None)?
        } else if has(PLAYER_CHARACTER_COMMANDS, kind) || has(PLAYER_CHARACTER_LIFECYCLE_COMMANDS, kind) {
            sanitize_player_character_command(&caller, &before, command)?
        } else if has(PLAYER_ITEM_COMMANDS, kind) {
            sanitize_player_item_command(&caller, &before, command)?
        } else if has(PLAYER_CAPTIVE_COMMANDS, kind) {
            sanitize_player_captive_command(&caller, &before, command)?
        } else if has(PLAYER_PICKPOCKET_COMMANDS, kind) {
            sanitize_player_pickpocket_command(&caller, &before, command)?
        } else if has(PLAYER_LOOT_COMMANDS, kind) {
            sanitize_player_loot_command(&caller, &before, command)?
        } else if has(PLAYER_BEAST_COMMANDS, kind) {
            sanitize_player_beast_command(&caller, &before, command)?
        } else if has(PLAYER_LAW_COMMANDS, kind) {
            sanitize_player_law_command(&caller, &before, command)?
        } else if has(PLAYER_TAVERN_COMMANDS, kind) {
            sanitize_player_tavern_command(&caller, &before, command)?
        } else if has(PLAYER_LETTER_COMMANDS, kind) {
            sanitize_player_letter_command(&caller, &before, command)?
        } else if has(PLAYER_BLESSING_COMMANDS, kind) {
            sanitize_player_blessing_command(&caller, &before, command)?
        } else if has(PLAYER_DIALOGUE_COMMANDS, kind) {
            sanitize_player_dialogue_command(&caller, &before, command)?
        } else if has(PLAYER_NPC_COMBAT_COMMANDS, kind) {
            sanitize_player_npc_combat_command(&caller, &before, command)?
        } else if kind == "MakeAttack" {
            // Права администратора меняют авторизацию MakeAttack, но не делают
            // клиентские поля авторитетными.
            if admin || (is_attack_replay && historical_actors.contains(&actor_of(command))) {
                normalize_make_attack_command(command, None)?
            } else {
                sanitize_player_combat_command(&caller, &before, command, is_attack_replay)?
            }
        } else if !admin {
            sanitize_player_combat_command(&caller, &before, command, false)?
        } else if has(PLAYER_COMBAT_COMMANDS, kind) {
            spread_with(command, "server_authoritative", Value::Bool(true))
        } else {
            command.clone()
        });
    }
    commands = sanitized;
    // CMD-01/02: повтор ключа сверяется с заявкой в форме санитайзера, до
    // серверных дополнений ниже (5627–5631).
    let request_commands = commands.clone();
    let mut rest_command = commands.iter().find(|command| has(PLAYER_REST_COMMANDS, &command_type(command))).cloned();
    if let Some(rest) = &rest_command {
        commands = expand_player_rest_command(rest);
    }
    let law_count = of_type(&commands, PLAYER_LAW_COMMANDS).len();
    if law_count > 0 && commands.len() != 1 {
        return Err(policy_error("Ответ страже должен быть отдельной атомарной командой", "PLAYER_COMMAND_FORBIDDEN").into());
    }
    if !of_type(&commands, PLAYER_TAVERN_COMMANDS).is_empty() && commands.len() != 1 {
        return Err(policy_error("Кости и выпивка идут отдельной атомарной командой", "PLAYER_COMMAND_FORBIDDEN").into());
    }
    if !of_type(&commands, PLAYER_BLESSING_COMMANDS).is_empty() && commands.len() != 1 {
        return Err(policy_error("Благословение идёт отдельной атомарной командой", "PLAYER_COMMAND_FORBIDDEN").into());
    }
    if !of_type(&commands, PLAYER_DIALOGUE_COMMANDS).is_empty() && commands.len() != 1 {
        return Err(policy_error("Выбор в разговоре идёт отдельной атомарной командой", "PLAYER_COMMAND_FORBIDDEN").into());
    }
    let set = orchestration(core, state)?;
    // Письмо: отказ движка до модели, повтор ключа без нового черновика
    // (5665–5673).
    if !of_type(&commands, PLAYER_LETTER_COMMANDS).is_empty() {
        if commands.len() != 1 {
            return Err(policy_error("Письмо идёт отдельной атомарной командой", "PLAYER_COMMAND_FORBIDDEN").into());
        }
        sk_rules::preview_checks::assert_send_letter_allowed(&before, &commands[0]).map_err(Failure::from)?;
        if core.events.get_by_idempotency_key(campaign_id, idempotency_key)?.is_none() {
            let model = SocialCourierModel { controller: set.npc_social.as_ref(), has_model: set.has_model };
            let letter = commands.remove(0);
            commands = vec![with_courier_reply_draft(&model, &before, letter).await];
        }
    }
    // Драка со стражей — следом штатный `StartCombat` (5679–5681).
    let law_fight = of_type(&commands, PLAYER_LAW_COMMANDS).first().map(|law| (js::string(get(Some(law), "resolution")), get(Some(law), "actor_id").cloned()));
    if let Some((resolution, actor_id)) = law_fight {
        if resolution == "fight" {
            let mut start = Map::new();
            start.insert("command_type".into(), Value::String("StartCombat".into()));
            // `actor_id: undefined` у JS — поля нет.
            if let Some(actor_id) = actor_id {
                start.insert("actor_id".into(), actor_id);
            }
            start.insert("server_authoritative".into(), Value::Bool(true));
            commands.push(Value::Object(start));
        }
    }
    // Кто действует (5682–5690).
    let actor = {
        let first = commands.first().and_then(|command| get(Some(command), "actor_id"));
        if js::truthy(first) {
            js::s(first)
        } else {
            string_or_empty(get(Some(&room_state), "activePlayerId"))
        }
    };
    let candidates: Vec<&Value> = array(get(Some(&room_state), "players")).iter().chain(array(get(Some(&room_state), "actors"))).collect();
    let command_actor = candidates.into_iter().find(|candidate| js::string(nullish(get(Some(candidate), "id"), get(Some(candidate), "actor_id"))) == actor).cloned();
    let controller = {
        let source = command_actor.as_ref();
        let pick = nullish(nullish(nullish(get(source, "controllerId"), get(source, "controller_id")), get(source, "ownerId")), get(source, "owner_id"));
        js::s(pick)
    };
    let code_value = Value::String(campaign_id.to_string());
    let owns = |hero: &str| caller.can_use_hero(Some(&Value::String(hero.to_string())), Some(&code_value));
    if !historical_actors.contains(&actor) && !owns(&actor)? && !(command_actor.as_ref().is_some_and(sk_core::game::is_party_summon) && owns(&controller)?) {
        return Err(Stop::Reply(StatusCode::FORBIDDEN, json!({ "error": ACTOR_FORBIDDEN_MESSAGE, "code": "ACTOR_FORBIDDEN" })));
    }
    let types: IndexSet<String> = commands.iter().map(command_type).collect();
    let types_any = |set: &[&str]| types.iter().any(|kind| has(set, kind));
    if types_any(SERVER_WORLD_COMMANDS) {
        return Err(policy_error("Переход сцены может создать только серверный контур Директора после подтверждённого решения группы", "DIRECTOR_COMMAND_REQUIRED").into());
    }
    if types_any(ADMIN_MERCHANT_LIFECYCLE_COMMANDS) {
        return Err(policy_error("Lifecycle-команды торговцев принимаются только отдельным административным endpoint /merchants/commands", "MERCHANT_LIFECYCLE_ENDPOINT_REQUIRED").into());
    }
    if types_any(SERVER_ENCOUNTER_COMMANDS) {
        return Err(policy_error("Создание столкновения принимается только endpoint /encounters/assemble", "ENCOUNTER_LIFECYCLE_ENDPOINT_REQUIRED").into());
    }
    let merchant_commands: Vec<Value> = of_type(&commands, PLAYER_MERCHANT_COMMANDS).into_iter().cloned().collect();
    let character_commands: Vec<Value> = of_type(&commands, PLAYER_CHARACTER_COMMANDS).into_iter().cloned().collect();
    let lifecycle_count = of_type(&commands, PLAYER_CHARACTER_LIFECYCLE_COMMANDS).len();
    let item_commands: Vec<Value> = of_type(&commands, PLAYER_ITEM_COMMANDS).into_iter().cloned().collect();
    let attack_commands: Vec<Value> = of_type(&commands, &["MakeAttack"]).into_iter().cloned().collect();
    let reaction_actor = js::s(get(get(get(get(Some(&room_state), "mechanics"), "combat"), "reaction_window"), "actor_id"));
    let resolves_reaction = commands.iter().any(|command| command_type(command) == "UseCombatAction" && js::s(get(Some(command), "actor_id")) == reaction_actor);
    if let Some(merchant) = merchant_commands.first() {
        let user_id = js::string(user.get("id"));
        if state.limits.exceeds_rate(&format!("merchant-command:{user_id}"), 120, None) {
            return Err(Stop::Reply(StatusCode::TOO_MANY_REQUESTS, json!({ "error": "Слишком много торговых операций. Подождите немного и повторите попытку", "code": "MERCHANT_RATE_LIMITED" })));
        }
        if commands.len() != 1 {
            return Err(policy_error("Торговая операция должна быть отдельной атомарной командой", "PLAYER_COMMAND_FORBIDDEN").into());
        }
        assert_merchant_idempotency(core, campaign_id, idempotency_key, merchant)?;
    }
    if !character_commands.is_empty() && character_commands.len() != commands.len() {
        return Err(policy_error("Изменения развития персонажа нельзя смешивать с игровым ходом", "PLAYER_COMMAND_FORBIDDEN").into());
    }
    if lifecycle_count > 0 && commands.len() != 1 {
        return Err(policy_error("Повышение уровня или импорт листа выполняются отдельной атомарной командой", "PLAYER_COMMAND_FORBIDDEN").into());
    }
    if !item_commands.is_empty() && commands.len() != 1 {
        return Err(policy_error("Действие с предметом должно быть отдельной атомарной командой", "PLAYER_COMMAND_FORBIDDEN").into());
    }
    if !of_type(&commands, PLAYER_CAPTIVE_COMMANDS).is_empty() && commands.len() != 1 {
        return Err(policy_error("Действие с пленным должно быть отдельной атомарной командой", "PLAYER_COMMAND_FORBIDDEN").into());
    }
    // Обыск атомарен целиком: весь набор или ничего (5728–5734).
    let loot_commands: Vec<Value> = of_type(&commands, PLAYER_LOOT_COMMANDS).into_iter().cloned().collect();
    if !loot_commands.is_empty() && commands.len() != 1 {
        return Err(policy_error("Обыск должен быть отдельной атомарной командой", "PLAYER_COMMAND_FORBIDDEN").into());
    }
    if let Some(loot) = loot_commands.first() {
        assert_loot_idempotency(core.events.as_ref(), campaign_id, idempotency_key, loot)?;
    }
    if !of_type(&commands, PLAYER_BEAST_COMMANDS).is_empty() && commands.len() != 1 {
        return Err(policy_error("Действие со зверем должно быть отдельной атомарной командой", "PLAYER_COMMAND_FORBIDDEN").into());
    }
    if let Some(item) = item_commands.first() {
        assert_item_idempotency(core.events.as_ref(), campaign_id, idempotency_key, item)?;
    }
    if let Some(rest) = rest_command.as_mut() {
        // JS правит объект отдыха на месте, а он же — первая команда пакета
        // (`expandPlayerRestCommand` возвращает его самого первым).
        assert_rest_idempotency(core.events.as_ref(), campaign_id, idempotency_key, rest)?;
        if let Some(first) = commands.first_mut() {
            *first = rest.clone();
        }
    }
    if !attack_commands.is_empty() {
        assert_make_attack_idempotency(core.events.as_ref(), campaign_id, idempotency_key, &attack_commands, None)?;
    }
    // Двухфазный ручной бросок: первая фаза без `roll` получает карточку,
    // вторая приносит серверный `roll_id` (5744–5755).
    let manual_roll = body.get("manual_roll") == Some(&Value::Bool(true)) || body.get("manualRoll") == Some(&Value::Bool(true));
    let mut verified_roll = Value::Null;
    let roll_id = get(body.get("roll"), "roll_id");
    if js::truthy(roll_id) {
        let roll_id = roll_id.cloned().unwrap_or(Value::Null);
        let options = json!({ "campaignId": campaign_id, "actorId": actor, "idempotencyKey": idempotency_key });
        let consumed = core.rolls.borrow_mut().consume(&roll_id, &options, None);
        verified_roll = consumed.map_err(Failure::from)?;
        pending.reservation = Some(RollReservation { roll_id: js::string(Some(&roll_id)), campaign_id: campaign_id.to_string(), idempotency_key: idempotency_key.to_string() });
    } else if js::truthy(body.get("roll")) {
        return Err(policy_error("Принимается только серверный roll_id", "UNVERIFIED_ROLL").into());
    }
    // `combatTurnCoordinator.hold(campaignId)` (5761–5763) — у ядра нет
    // координатора автохода (С17), удерживать нечего.
    let message = {
        let text = body.get("message");
        if js::truthy(text) {
            js::s(text)
        } else {
            "Структурированная команда".to_string()
        }
    };
    let input = json!({
        "state": room_state,
        "campaignId": campaign_id,
        "playerId": actor,
        "message": message,
        "commands": commands,
        "requestCommands": request_commands,
        "idempotencyKey": idempotency_key,
        "user": user,
        "allowedActorIds": admitted.hero_ids,
        "manualRoll": manual_roll,
        "verifiedRoll": verified_roll,
    });
    let mut result = set.game.handle(HandleInput::new(input)).await.map_err(orchestrator_failure)?;
    // Ход исполнен: бросок остаётся потреблённым.
    if let Some(reservation) = &pending.reservation {
        let options = json!({ "idempotencyKey": idempotency_key, "committed": true });
        core.rolls.borrow_mut().finish_reservation(&Value::String(reservation.roll_id.clone()), &options).map_err(Failure::from)?;
        pending.reservation = None;
    }
    let viewer_actor = Value::String(actor.clone());
    // Карточка проверки: мир не изменился, ответ уходит как есть (5772).
    if js::truthy(result.get("check")) {
        let payload = spread_with(&result, "room_version", Value::from(room.version));
        let reply = sk_projection::viewer_projection::turn_result_for_viewer(Some(&payload), Some(user), Some(&viewer_actor)).map_err(Failure::from)?;
        return Ok((StatusCode::OK, reply.unwrap_or(Value::Null)));
    }
    if let Some(merchant) = merchant_commands.first() {
        assert_merchant_result_fingerprint(&result, merchant)?;
    }
    if !character_commands.is_empty() {
        assert_character_build_result_fingerprint(&result, &character_commands)?;
    }
    if let Some(item) = item_commands.first() {
        assert_item_result_fingerprint(&result, item)?;
    }
    if let Some(loot) = loot_commands.first() {
        assert_loot_result_fingerprint(&result, loot)?;
    }
    if let Some(rest) = &rest_command {
        assert_rest_result_fingerprint(&result, rest)?;
    }
    if !attack_commands.is_empty() {
        assert_make_attack_result_fingerprint(&result, &attack_commands)?;
    }
    if let Some(npc_combat) = preflight_npc_combat.first() {
        assert_npc_combat_result_fingerprint(&result, npc_combat)?;
    }
    if js::truthy(result.get("authoritative_state")) {
        settle_after_commit(core, &set, campaign_id, &mut result, &types, resolves_reaction).await?;
    }
    respond(core, &set, admitted, &actor, command_actor.as_ref(), &types, &merchant_commands, result).await
}

/// Продолжение боя и свежая голова журнала (5780–5806).
async fn settle_after_commit(core: &Rc<GameCore>, set: &Orchestration, campaign_id: &str, result: &mut Value, types: &IndexSet<String>, resolves_reaction: bool) -> Result<(), Stop> {
    let authoritative = result.get("authoritative_state").cloned().unwrap_or(Value::Null);
    let original = nullish(result.get("state_version"), get(Some(&authoritative), "state_version")).cloned().unwrap_or(Value::from(0));
    let original_version = js::number(Some(&original));
    let has_type = |kind: &str| types.contains(kind);
    let combat_active = js::truthy(get(get(get(Some(&authoritative), "mechanics"), "combat"), "active"));
    let should_settle = types.iter().any(|kind| has(PLAYER_COMBAT_COMMANDS, kind)) || ((has_type("UseItem") || has_type("LootContainer")) && combat_active);
    let mechanics = array(result.get("mechanics")).to_vec();
    let turns = if should_settle {
        // Удар из исследования открывает бой сам: если первым ходит враг, его
        // ход идёт так же, как после «Начать бой».
        let advance_npc = has_type("StartCombat")
            || has_type("AttackNpc")
            || has_type("EndTurn")
            || resolves_reaction
            || mechanics.iter().any(|event| get(Some(event), "event_type").and_then(Value::as_str) == Some("CombatStarted"));
        settle_combat_continuation(core, set, campaign_id, advance_npc).await?
    } else {
        Vec::new()
    };
    let latest = core.events.load(campaign_id, &LoadOptions::default())?;
    let subsequent = if (latest.state_version as f64) > original_version { core.events.get_events(campaign_id, original_version as i64, Some(latest.state_version))? } else { Vec::new() };
    let identity = |event: &Value| match get(Some(event), "event_id") {
        Some(id) if !id.is_null() => js::string(Some(id)),
        _ => format!("{}:{}", js::string(get(Some(event), "state_version_after")), js::string(get(Some(event), "event_type"))),
    };
    let mut seen = HashSet::new();
    let merged: Vec<Value> = mechanics.into_iter().chain(subsequent).filter(|event| seen.insert(identity(event))).collect();
    if let Some(map) = result.as_object_mut() {
        map.insert("state_version".into(), Value::from(latest.state_version));
        map.insert("authoritative_state".into(), latest.state);
        map.insert("mechanics".into(), Value::Array(merged));
        map.insert("npc_turns".into(), Value::Array(turns));
    }
    Ok(())
}

/// Летопись хода, критический момент и ответ зрителю (5807–5919).
#[allow(clippy::too_many_arguments)]
async fn respond(core: &Rc<GameCore>, set: &Orchestration, admitted: &Admitted, actor: &str, command_actor: Option<&Value>, types: &IndexSet<String>, merchant_commands: &[Value], mut result: Value) -> Result<(StatusCode, Value), Stop> {
    let campaign_id = admitted.campaign_id.as_str();
    let user = &admitted.user;
    let idempotency_key = admitted.idempotency_key.as_str();
    let actor_value = Value::String(actor.to_string());
    let committed_state = result.get("authoritative_state").filter(|state| js::truthy(Some(state))).cloned();
    let mechanics = array(result.get("mechanics")).to_vec();
    let end_turn = types.contains("EndTurn");
    // Ход, который зовёт рассказчика, узнаётся по тем же событиям, что и
    // реплика; слова игрока к ходу в бою — тоже (5807–5816).
    let player_note = if committed_state.is_some() { player_note_from(&admitted.body) } else { String::new() };
    let critical_trigger = committed_state.as_ref().and_then(|state| {
        sk_agents::creative_director::critical_moment_for(&mechanics, state)
            .or_else(|| sk_agents::creative_director::hero_flourish_for(&mechanics, state, Some(&Value::String(player_note.clone())), Some(&actor_value)))
    });
    let tactical = match &committed_state {
        Some(state) => {
            let options = json!({ "npcTurns": result.get("npc_turns").cloned().unwrap_or(Value::Null) });
            let options = if result.get("npc_turns").is_some() { options } else { json!({}) };
            sk_narration::combat_narration::tactical_narration_parts(&mechanics, state, Some(&options)).map_err(|error| Failure::new(error.to_string(), None))?
        }
        None => sk_narration::combat_narration::NarrationParts { main: String::new(), sky: String::new() },
    };
    let voice = sk_narration::combat_narration::combat_journal_voice(&mechanics, committed_state.as_ref().unwrap_or(&Value::Null));
    let narration_key_id = combat_message_id(idempotency_key);
    let author_state = committed_state.clone().unwrap_or(Value::Null);
    let note_entry = (!player_note.is_empty()).then(|| {
        json!({
            "id": player_message_id(&format!("{idempotency_key}:note")),
            "text": player_note,
            "speaker": "player",
            "author": player_note_author(&author_state, command_actor, Some(&actor_value)),
        })
    });
    let tactical_text = [tactical.main.as_str(), tactical.sky.as_str()].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    let merchant_text = if merchant_commands.is_empty() {
        String::new()
    } else {
        let narration = result.get("narration");
        if js::truthy(narration) {
            js::s(narration)
        } else {
            String::new()
        }
    };
    let trigger_kind = js::s(get(critical_trigger.as_ref(), "kind"));
    let additive_moment = trigger_kind == "hero_flourish" || trigger_kind == "critical_hit";
    let entry = |id: String, text: String, turn_consumed: bool| -> Value {
        let mut entry = Map::new();
        entry.insert("id".into(), Value::String(id));
        entry.insert("text".into(), Value::String(text));
        entry.insert("turnConsumed".into(), Value::Bool(turn_consumed));
        entry.insert("speaker".into(), Value::String(voice.speaker.into()));
        entry.insert("author".into(), Value::String(voice.author.into()));
        Value::Object(entry)
    };
    let turn_entry = if critical_trigger.is_some() {
        (!tactical.main.is_empty()).then(|| entry(combat_message_id(&format!("{idempotency_key}:log")), tactical.main.clone(), additive_moment && end_turn))
    } else if !tactical_text.is_empty() {
        Some(entry(narration_key_id.clone(), tactical_text.clone(), end_turn))
    } else if !merchant_text.is_empty() {
        Some(entry(merchant_message_id(idempotency_key), merchant_text.clone(), end_turn))
    } else {
        None
    };
    // Разговор с вариантами: реплика героя и ответ собеседника (5850–5861).
    let dialogue_chosen = mechanics.iter().find(|event| get(Some(event), "event_type").and_then(Value::as_str) == Some("DialogueOptionChosen")).and_then(|event| get(Some(event), "payload")).filter(|payload| !payload.is_null()).cloned();
    let mut dialogue_entries = Vec::new();
    if let Some(chosen) = &dialogue_chosen {
        let label = js::s(get(Some(chosen), "label"));
        dialogue_entries.push(json!({
            "id": player_message_id(&format!("{idempotency_key}:dialogue")),
            "text": label,
            "speaker": "player",
            "author": player_note_author(&author_state, command_actor, Some(&actor_value)),
        }));
        let check_line = sk_story::campaign_dialogues::dialogue_check_line(get(Some(chosen), "check"));
        let reply = js::s(get(Some(chosen), "reply"));
        let text = [check_line, reply].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n");
        let npc_name = get(Some(chosen), "npc_name");
        let author = if js::truthy(npc_name) { js::s(npc_name) } else { "Собеседник".to_string() };
        dialogue_entries.push(json!({
            "id": narration_message_id(&format!("{idempotency_key}:dialogue")),
            "text": text,
            "speaker": "narrator",
            "author": author,
            "turnConsumed": false,
        }));
    }
    let first_entries: Vec<Value> = note_entry.into_iter().chain(dialogue_entries).chain(turn_entry.clone()).collect();
    // Строка хода ложится в летопись сразу после commit, до ожидания
    // рассказчика (5862–5866).
    let projected = match &committed_state {
        Some(state) => {
            let journal = (!first_entries.is_empty()).then(|| Value::Array(first_entries.clone()));
            persist_authoritative_projection(core, campaign_id, state, &mechanics, journal.as_ref(), PersistOptions { force_projector_refresh: false, await_projection: true })?
        }
        None => None,
    };
    let mut journaled: Option<Room> = None;
    let mut creative_moment: Option<Value> = None;
    let mut narrator_text = String::new();
    if let (Some(trigger), Some(state)) = (&critical_trigger, &committed_state) {
        // Повтор ключа отдаёт уже записанную реплику, а не зовёт рассказчика
        // второй раз (5870–5878).
        let current = get_room(core, campaign_id)?;
        let stored = array(current.state.as_ref().and_then(|state| state.get("messages")))
            .iter()
            .find(|message| js::string(get(Some(message), "id")) == narration_key_id && get(Some(message), "speaker").and_then(Value::as_str) == Some("narrator"))
            .and_then(|message| get(Some(message), "text"))
            .filter(|text| js::truthy(Some(text)))
            .map(|text| js::s(Some(text)));
        if let Some(text) = stored {
            creative_moment = Some(json!({ "trigger": trigger, "provider": "journal-replay" }));
            narrator_text = text;
        } else {
            let mut viewer = Map::new();
            viewer.insert("playerId".into(), actor_value.clone());
            viewer.insert("partyIds".into(), Value::Array(admitted.hero_ids.clone()));
            viewer.insert("isPartyMember".into(), Value::Bool(true));
            if let Some(role) = user.get("role") {
                viewer.insert("role".into(), role.clone());
            }
            let recent: Vec<Value> = recent_narrator_texts(current.state.as_ref(), 6).into_iter().map(Value::String).collect();
            let input = json!({
                "events": mechanics,
                "state": state,
                "viewer": Value::Object(viewer),
                "recentNarrations": recent,
                "playerNote": player_note,
                "actorId": actor,
            });
            let rendered = set.creative.render_critical_moment(&input).await.map_err(|error| Failure::new(format!("{error:?}"), None))?;
            let narration = get(rendered.as_ref(), "narration");
            narrator_text = [if js::truthy(narration) { js::s(narration) } else { String::new() }, tactical.sky.clone()].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
            creative_moment = rendered;
            // Летопись — отдельным шагом и всегда: комната за время ожидания
            // могла уйти вперёд.
            if !narrator_text.is_empty() {
                let line = json!({
                    "id": narration_key_id,
                    "text": narrator_text,
                    "turnConsumed": !additive_moment && end_turn,
                    "speaker": "narrator",
                    "author": "Рассказчик",
                });
                journaled = append_room_journal(core, campaign_id, &[line])?;
            }
        }
    }
    // Реплика уже в летописи: координатор может играть следующий ход
    // (`releaseCombatHold`, С17).
    let narrator_spoke = critical_trigger.is_some() && !narrator_text.is_empty();
    let narration = if narrator_spoke { narrator_text.clone() } else { js::s(get(turn_entry.as_ref(), "text")) };
    if !narration.is_empty() {
        if let Some(map) = result.as_object_mut() {
            map.insert("narration".into(), Value::String(narration));
            let message_id = if narrator_spoke { Some(Value::String(narration_key_id.clone())) } else { get(turn_entry.as_ref(), "id").cloned() };
            match message_id {
                Some(id) => map.insert("narration_message_id".into(), id),
                None => map.remove("narration_message_id"),
            };
            map.insert("narration_speaker".into(), Value::String(if narrator_spoke { "narrator" } else { voice.speaker }.into()));
            map.insert("narration_author".into(), Value::String(if narrator_spoke { "Рассказчик" } else { voice.author }.into()));
            map.insert("creative_trigger".into(), nullish(get(creative_moment.as_ref(), "trigger"), None).cloned().unwrap_or(Value::Null));
            map.insert("creative_provider".into(), nullish(get(creative_moment.as_ref(), "provider"), None).cloned().unwrap_or(Value::Null));
        }
    }
    let latest_room = match journaled {
        Some(room) => Some(room),
        None if critical_trigger.is_some() => Some(get_room(core, campaign_id)?),
        None => projected,
    };
    // `latestRoom?.state ?? committedState`: без состояния — поле `undefined`.
    let response_state: Option<Value> = match latest_room.as_ref().and_then(|room| room.state.clone()) {
        Some(state) => Some(state),
        None => result.get("authoritative_state").cloned(),
    };
    let merchant_view = match (merchant_commands.first(), &response_state) {
        (Some(command), Some(state)) if js::truthy(Some(state)) => sk_economy::merchant_economy::merchant_view_for(state, get(Some(command), "merchant_id"), get(Some(command), "actor_id")),
        _ => None,
    };
    if let Some(map) = result.as_object_mut() {
        match response_state {
            Some(state) => {
                map.insert("authoritative_state".into(), state);
            }
            None => {
                map.remove("authoritative_state");
            }
        }
        if let Some(view) = merchant_view.filter(|view| js::truthy(Some(view))) {
            map.insert("merchant_view".into(), view);
        }
        map.insert("room_version".into(), Value::from(latest_room.as_ref().map_or(admitted.room.version, |room| room.version)));
    }
    let reply = sk_projection::viewer_projection::turn_result_for_viewer(Some(&result), Some(user), Some(&actor_value)).map_err(Failure::from)?;
    Ok((StatusCode::OK, reply.unwrap_or(Value::Null)))
}

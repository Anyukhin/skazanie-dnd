//! Проекция журнала в комнату — перенос `server/index.mjs:3013–3020,
//! 3383–3595, 3623–3696`: `latestCampaignState`,
//! `persistAuthoritativeProjection`, `reconcileCampaignProjection`,
//! `reconcileAllCampaignProjections`, `persistInteractionProjection`,
//! `expirePartyDecisionIfNeeded`, `reconcilePartyDecisionPresence` и хук
//! «проекция записана» (бывший `onRoomSaved`).
//!
//! Подтверждение проекции (`acknowledgeProjection`) после записи комнаты идёт
//! в **той же транзакции SQLite**, что и счётчик `room.version`
//! ([`crate::room::save_room_with_ack`]). Без записи комнаты (быстрый путь
//! равной версии, сверка совпавшей комнаты) подтверждение — отдельный вызов
//! журнала, как в JS. `awaitProjection: false` в JS — обещание без ожидания с
//! проглоченной ошибкой; здесь подтверждение синхронно, ошибка так же
//! проглатывается, а с `await_projection` возвращается вызывающему (запись
//! комнаты при этом остаётся, как после `await projected.projectionAck` в JS).
//!
//! Журнал в ядре вызывается синхронно (см. `core`), поэтому функции здесь
//! синхронные; асинхронна только [`persist_interaction_projection`] —
//! голосующие читаются из аккаунтов через `blocking`.

use std::rc::Rc;
use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_narration_base::projection_integrity::CANONICAL_PROJECTION_FIELDS;
use sk_store::accounts::Accounts;
use sk_store::executor::{AuthoritativeExecutor, DeriveEvents, DerivedRequest, Executed, ExecutorError, Producer};
use sk_store::{LoadOptions, RoomProjectionAck};

use crate::core::{CoreError, GameCore, LocalFuture};
use crate::error::Failure;
use crate::journal::{journal_candidates_for, journal_entry, room_messages, ROOM_JOURNAL_LIMIT};
use crate::room::{get_room, Room};

/// Строка летописи, которую проекция дописывает вместе с собой
/// (`journalMessage` в `persistAuthoritativeProjection`): запись или список.
pub type JournalMessage = Value;

/// Параметры `persistAuthoritativeProjection(..., { forceProjectorRefresh, awaitProjection })`.
#[derive(Debug, Clone, Copy, Default)]
pub struct PersistOptions {
    pub force_projector_refresh: bool,
    pub await_projection: bool,
}

/// Журнал для `AuthoritativeExecutor` ядра: коммит — через
/// [`crate::test_hooks::commit`] (сбои `DND_COMMIT_FAULTS`, С2), чтение —
/// напрямую. Все исполнители сервера строятся над ним, а не над `EventStore`.
pub struct HookedJournal<'a>(pub &'a sk_store::EventStore);

impl sk_store::executor::Journal for HookedJournal<'_> {
    fn load(&self, campaign_id: &str) -> sk_store::StoreResult<sk_store::Loaded> {
        self.0.load(campaign_id, &LoadOptions::default())
    }

    fn commit(&self, request: sk_store::CommitRequest) -> sk_store::StoreResult<sk_store::CommitResult> {
        crate::test_hooks::commit(self.0, request)
    }

    fn get_by_idempotency_key(&self, campaign_id: &str, key: &str) -> sk_store::StoreResult<Option<sk_store::CommitResult>> {
        self.0.get_by_idempotency_key(campaign_id, key)
    }
}

pub(crate) fn executor_failure(error: ExecutorError) -> Failure {
    match error {
        ExecutorError::Store(error) => Failure::from(error),
        ExecutorError::Rule(error) => Failure::from(error),
        ExecutorError::Executor { code, message } => Failure::new(message, Some(code)),
    }
}

fn party_failure(error: sk_memory::party_decision::PartyDecisionError) -> Failure {
    Failure::new(error.message, Some(&error.code))
}

fn party_rule(error: sk_memory::party_decision::PartyDecisionError) -> sk_core::RuleError {
    sk_core::RuleError::new(error.code, error.message)
}

fn normalize(state: &Value) -> Result<Value, Failure> {
    Ok(sk_rules::normalize::normalize_campaign_state(state)?)
}

/// `latestCampaignState(campaignId, fallbackState)` (3013–3020): состояние
/// журнала, а при любом сбое загрузки или нормализации — нормализованное
/// запасное.
pub fn latest_campaign_state(core: &GameCore, campaign_id: &str, fallback_state: Option<&Value>) -> Result<Value, Failure> {
    let _span = sk_store::perf::span("latest_campaign_state");
    // Голова журнала уже нормализована (урок 4): копия — только своё значение.
    let loaded = core.events.load(campaign_id, &LoadOptions::default()).map_err(Failure::from).and_then(|loaded| Ok(sk_rules::normalized::NormalizedState::from_loaded(&loaded)?.into_value()));
    match loaded {
        Ok(state) => Ok(state),
        Err(_) => normalize(fallback_state.unwrap_or(&Value::Null)),
    }
}

/// `Number(x)` поля состояния комнаты с запасным значением для `undefined`/`null`.
fn version_of(state: Option<&Value>, fallback: f64) -> f64 {
    match state.and_then(|state| state.get("state_version")) {
        None | Some(Value::Null) => fallback,
        value => js::number(value),
    }
}

/// Подтверждение проекции вне записи комнаты: с `await_projection` ошибка
/// возвращается, иначе проглатывается (`void promise.catch(() => {})`).
fn acknowledge(core: &GameCore, campaign_id: &str, version: i64, hash: &str, options: PersistOptions) -> Result<(), Failure> {
    let outcome = crate::test_hooks::acknowledge_projection(&core.events, campaign_id, version, Some(hash));
    match outcome {
        Err(error) if options.await_projection => Err(error.into()),
        _ => Ok(()),
    }
}

/// `{ ...player }` для героя (не объект — пустой).
fn spread_object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// Состояние комнаты после полной проекции (`next`, 3418–3470).
fn projected_room_state(room_state: &Value, engine_state: &Value, events: &[Value], journal_message: Option<&Value>, options: PersistOptions) -> Result<Value, Failure> {
    let mut messages = room_messages(room_state)?;
    for candidate in journal_candidates_for(events, journal_message) {
        let id = js::string(candidate.get("id"));
        if messages.iter().any(|message| js::string(message.get("id")) == id) {
            continue;
        }
        messages.push(journal_entry(&candidate));
    }
    if messages.len() > ROOM_JOURNAL_LIMIT {
        messages.drain(..messages.len() - ROOM_JOURNAL_LIMIT);
    }
    let room_players = match room_state.get("players") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(players)) => players.as_slice(),
        Some(_) => return Err(Failure::new("room.state.players.map is not a function", Some("TYPE_ERROR"))),
    };
    let mut online_by_id: Map<String, Value> = Map::new();
    for player in room_players {
        online_by_id.insert(js::string(player.get("id")), Value::Bool(js::truthy(player.get("online"))));
    }
    // `{ ...room, ...engine }` без канонических полей, которых у движка нет:
    // порядок ключей — комнаты, новые поля движка — в конце в его порядке.
    // Значения комнаты, которые движок тут же заменит, не копируются, и само
    // состояние движка целиком не копируется (урок 11).
    let empty = Map::new();
    let engine = engine_state.as_object().unwrap_or(&empty);
    let room = room_state.as_object().unwrap_or(&empty);
    let mut next = Map::new();
    for (field, value) in room {
        match engine.get(field) {
            Some(engine_value) => {
                next.insert(field.clone(), engine_value.clone());
            }
            None if CANONICAL_PROJECTION_FIELDS.contains(&field.as_str()) => {}
            None => {
                next.insert(field.clone(), value.clone());
            }
        }
    }
    for (field, value) in engine {
        if !next.contains_key(field) {
            next.insert(field.clone(), value.clone());
        }
    }
    next.insert("agentInteraction".into(), engine.get("agentInteraction").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null));
    let engine_players = match engine.get("players") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(players)) => players.as_slice(),
        Some(_) => return Err(Failure::new("engineState.players.map is not a function", Some("TYPE_ERROR"))),
    };
    let players: Vec<Value> = engine_players
        .iter()
        .map(|player| {
            let mut map = spread_object(player);
            if let Some(online) = online_by_id.get(&js::string(player.get("id"))) {
                map.insert("online".into(), online.clone());
            }
            Value::Object(map)
        })
        .collect();
    next.insert("players".into(), Value::Array(players));
    next.insert("messages".into(), Value::Array(messages));
    next.insert("state_projector_version".into(), Value::from(sk_rules::constants::GAME_STATE_PROJECTOR_VERSION));
    if options.force_projector_refresh {
        next.insert("engine_mode".into(), Value::String("enforce".into()));
    }
    normalize(&Value::Object(next))
}

/// `persistAuthoritativeProjection(campaignId, engineState, events,
/// journalMessage, options)` (3382–3496): переписать комнату из
/// авторитетного состояния и подтвердить совпавшую проекцию. Отставшая
/// проекция (версия меньше комнатной) пишет только летопись. `None` — версия
/// не целая, комнаты нет или три конфликта подряд без совпавшей сверки.
pub fn persist_authoritative_projection(
    core: &Rc<GameCore>,
    campaign_id: &str,
    engine_state: &Value,
    events: &[Value],
    journal_message: Option<&Value>,
    options: PersistOptions,
) -> Result<Option<Room>, Failure> {
    let proposed = match engine_state.get("state_version") {
        None | Some(Value::Null) => -1.0,
        value => js::number(value),
    };
    if !(proposed.is_finite() && proposed.fract() == 0.0 && proposed.abs() <= 9_007_199_254_740_991.0) {
        return Ok(None);
    }
    let proposed_version = proposed as i64;
    let _span = sk_store::perf::span("persist");
    for _attempt in 0..3 {
        let room = {
            let _span = sk_store::perf::span("persist.get_room");
            get_room(core, campaign_id)?
        };
        let Some(room_state) = room.state.as_ref() else { return Ok(None) };
        let current = version_of(Some(room_state), 0.0);
        if proposed < current {
            // Комнату обогнала более свежая проекция: состояние отсюда не
            // пишется, но летопись этого хода — не состояние (плейтест 2026-10-10).
            let appended = crate::journal::append_room_journal(core, campaign_id, &journal_candidates_for(events, journal_message))?;
            return match appended {
                Some(room) => Ok(Some(room)),
                None => get_room(core, campaign_id).map(Some),
            };
        }
        if !options.force_projector_refresh && proposed == current && journal_message.is_none() {
            // SEC-02: равная версия ещё не значит равное содержимое.
            let comparison = sk_tactics::cutover_audit::compare_js_projection(engine_state, room_state);
            if comparison.matched {
                acknowledge(core, campaign_id, proposed_version, &comparison.projected_hash, options)?;
                return Ok(Some(room));
            }
        }
        let next = {
            let _span = sk_store::perf::span("persist.projected_room_state");
            projected_room_state(room_state, engine_state, events, journal_message, options)?
        };
        // Сверка — два sha256 по всему каноническому состоянию: считаем её один
        // раз; `isNarrating` в каноническую проекцию не входит.
        let comparison = {
            let _span = sk_store::perf::span("persist.compare_projection");
            sk_tactics::cutover_audit::compare_js_projection(engine_state, &next)
        };
        let ack = comparison.matched.then(|| RoomProjectionAck { campaign_id: campaign_id.to_string(), projected_version: proposed_version, projection_hash: Some(comparison.projected_hash.clone()) });
        let (saved, acknowledged) = {
            let _span = sk_store::perf::span("persist.save_room");
            crate::room::save_composed_room_with_ack(core, campaign_id, &next, room.version, ack)?
        };
        if !saved.conflict {
            if let Some(Err(error)) = acknowledged {
                if options.await_projection {
                    return Err(error.into());
                }
            }
            return Ok(Some(saved.room));
        }
    }
    let reconciled = get_room(core, campaign_id)?;
    if version_of(reconciled.state.as_ref(), -1.0) >= proposed {
        let comparison = sk_tactics::cutover_audit::compare_js_projection(engine_state, reconciled.state.as_ref().unwrap_or(&Value::Null));
        if comparison.matched {
            acknowledge(core, campaign_id, proposed_version, &comparison.projected_hash, options)?;
            return Ok(Some(reconciled));
        }
    }
    Ok(None)
}

/// Разбор плана Rules Engine для исполнителя (`authoritativeExecutor` JS
/// держит `rulesEngine` с общим `diceService`). `pub(crate)` — С13: команды
/// карты (`routes::map_import`) идут через тот же исполнитель.
pub(crate) fn with_rules_plan<T>(core: &GameCore, operation: impl FnOnce(&sk_store::executor::ResolvePlan<'_>) -> T) -> T {
    let engine = std::cell::RefCell::new(sk_rules::resolve::api::RulesEngine::new(Box::new(sk_rules::dice_record::ServiceDice::new(core.dice.clone()))));
    let resolve = |commands: &[Value], state: &Value, context: &Value| -> Result<Value, sk_core::RuleError> {
        let plan = json!({ "proposed_commands": commands });
        match engine.borrow_mut().resolve_plan(&plan, state, &sk_rules::context::Context::from_json(context)) {
            Ok(resolved) => Ok(json!({ "commands": resolved.commands, "events": resolved.events, "rolls": resolved.rolls, "state": resolved.state })),
            Err(sk_rules::pause::Halt::Rule(error)) => Err(error),
            Err(other) => Err(sk_core::RuleError::new(other.code().unwrap_or("ENGINE_FAULT").to_string(), other.to_string())),
        }
    };
    operation(&resolve)
}

/// `reconcileCampaignProjection(campaignId)` (3498–3535): истечь голосование,
/// исполнить решённое задание, сверить комнату с головой журнала и либо
/// подтвердить совпавшую, либо переписать. Кампании нет в журнале — комната
/// как есть.
pub fn reconcile_campaign_projection(core: &Rc<GameCore>, campaign_id: &str) -> Result<Option<Room>, Failure> {
    reconcile_campaign_projection_at(core, campaign_id, sk_core::clock::now_ms())
}

/// [`reconcile_campaign_projection`] с явным «сейчас» (истечение голосований).
pub fn reconcile_campaign_projection_at(core: &Rc<GameCore>, campaign_id: &str, now_ms: i64) -> Result<Option<Room>, Failure> {
    match reconcile_inner(core, campaign_id, now_ms) {
        Err(failure) if failure.code.as_deref() == Some("CAMPAIGN_NOT_FOUND") => get_room(core, campaign_id).map(Some),
        other => other,
    }
}

fn expiry_pending(state: &Value, now_ms: i64) -> Result<bool, Failure> {
    let expiry = sk_memory::party_decision::party_decision_expiry_events(state, Some(now_ms as f64)).map_err(party_failure)?;
    Ok(expiry.get("events").and_then(Value::as_array).is_some_and(|events| !events.is_empty()))
}

fn reconcile_inner(core: &Rc<GameCore>, campaign_id: &str, now_ms: i64) -> Result<Option<Room>, Failure> {
    let _span = sk_store::perf::span("reconcile");
    // Обычный случай (Ск4): голосование не истекает, решённого задания нет,
    // комната совпадает с головой — голова читается по ссылке, без копии
    // состояния. Любое действие — прежний путь целиком.
    let quiet = core.events.inspect(campaign_id, &LoadOptions::default(), |state, _| -> Result<bool, Failure> {
        Ok(!expiry_pending(state, now_ms)? && !sk_character::quest_decisions::quest_decision_pending(Some(state)))
    })??;
    if quiet {
        let pending = core.events.pending_projection(campaign_id, false)?;
        let room = get_room(core, campaign_id)?;
        let Some(room_state) = room.state.as_ref() else {
            return Err(Failure::new("Cannot convert undefined or null to object", Some("TYPE_ERROR")));
        };
        let projected_version = version_of(Some(room_state), -1.0);
        let (comparison, head_version) = {
            let _compare = sk_store::perf::span("reconcile.compare");
            core.events.inspect(campaign_id, &LoadOptions::default(), |state, version| (sk_tactics::cutover_audit::compare_js_projection(state, room_state), version))?
        };
        if projected_version >= head_version as f64 && comparison.matched {
            if pending.is_some() {
                crate::test_hooks::acknowledge_projection(&core.events, campaign_id, head_version, Some(&comparison.projected_hash))?;
            }
            return Ok(Some(room));
        }
        let authoritative = core.events.load(campaign_id, &LoadOptions::default())?;
        let events = pending.map(|pending| pending.events).unwrap_or_default();
        return persist_authoritative_projection(core, campaign_id, &authoritative.state, &events, None, PersistOptions { force_projector_refresh: true, await_projection: false });
    }
    let load = || core.events.load(campaign_id, &LoadOptions::default()).map_err(Failure::from);
    let mut authoritative = load()?;
    if expiry_pending(&authoritative.state, now_ms)? {
        expire_party_decision_if_needed(core, campaign_id, now_ms)?;
        authoritative = load()?;
    }
    let journal = HookedJournal(&core.events);
    let quest = with_rules_plan(core, |resolve| sk_character::quest_decisions::finish_quest_decision(&AuthoritativeExecutor::new(&journal), campaign_id, Some(&authoritative.state), resolve));
    if quest.map_err(|error| Failure::new(error.message().to_string(), Some(error.code())))?.is_some() {
        authoritative = load()?;
    }
    let pending = core.events.pending_projection(campaign_id, false)?;
    let room = get_room(core, campaign_id)?;
    let Some(room_state) = room.state.as_ref() else {
        // `canonicalProjection(null)` в JS: `Object.hasOwn(null, …)` бросает.
        return Err(Failure::new("Cannot convert undefined or null to object", Some("TYPE_ERROR")));
    };
    let projected_version = version_of(Some(room_state), -1.0);
    let comparison = sk_tactics::cutover_audit::compare_js_projection(&authoritative.state, room_state);
    if projected_version >= authoritative.state_version as f64 && comparison.matched {
        if pending.is_some() {
            crate::test_hooks::acknowledge_projection(&core.events, campaign_id, authoritative.state_version, Some(&comparison.projected_hash))?;
        }
        return Ok(Some(room));
    }
    let events = pending.map(|pending| pending.events).unwrap_or_default();
    persist_authoritative_projection(core, campaign_id, &authoritative.state, &events, None, PersistOptions { force_projector_refresh: true, await_projection: false })
}

/// `reconcileAllCampaignProjections()` (3575–3583): сверка всех комнат при
/// старте. Сбой одной кампании пишется в лог и не мешает остальным; ответ —
/// отказы по кампаниям (для лога и тестов). Ошибка — только если не
/// прочитался сам список комнат (в JS — падение старта).
pub fn reconcile_all_campaign_projections(core: &Rc<GameCore>) -> Result<Vec<(String, Failure)>, Failure> {
    let mut failures = Vec::new();
    for campaign_id in crate::room::list_room_codes(core)? {
        if let Err(error) = reconcile_campaign_projection(core, &campaign_id) {
            eprintln!("[Сказание] Не удалось восстановить projection {campaign_id}: {error}");
            failures.push((campaign_id, error));
        }
    }
    Ok(failures)
}

/// `persistInteractionProjection(campaignId, interaction)` (3623–3655):
/// открыть голосование отряда событием и спроецировать. Голосующие — по
/// подключённым героям ([`crate::streams::Presence`]), иначе по `online`,
/// иначе весь отряд.
pub async fn persist_interaction_projection(core: Rc<GameCore>, accounts: Arc<Accounts>, campaign_id: &str, interaction: &Value) -> Result<Option<Room>, Failure> {
    if !js::is_plain(Some(interaction)) {
        return Ok(None);
    }
    let idempotency_key = format!("party-decision-open:{}", sk_core::text::head(&js::s(interaction.get("id")), 120));
    let loaded = core.events.load(campaign_id, &LoadOptions::default())?;
    let state = &loaded.state;
    if let Some(current) = state.get("agentInteraction").filter(|value| js::truthy(Some(value))) {
        if js::string(current.get("id")) != js::string(interaction.get("id")) {
            return Ok(None);
        }
        return persist_authoritative_projection(&core, campaign_id, state, &[], None, PersistOptions { force_projector_refresh: true, await_projection: false });
    }
    let players = state.get("players").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let member_ids: Vec<String> = match state.get("partyMemberIds") {
        Some(Value::Array(ids)) if !ids.is_empty() => ids.iter().map(|id| js::string(Some(id))).collect(),
        _ => players.iter().map(|player| js::string(player.get("id"))).collect(),
    };
    let mut party_members: Vec<String> = Vec::new();
    for id in member_ids {
        if !party_members.contains(&id) {
            party_members.push(id);
        }
    }
    let connected = core.streams.connected_hero_ids(campaign_id);
    let candidates: Vec<String> = if connected.is_empty() {
        players.iter().filter(|player| js::truthy(player.get("online"))).map(|player| js::string(player.get("id"))).collect()
    } else {
        connected.iter().cloned().collect()
    };
    let mut eligible: Vec<String> = candidates.into_iter().filter(|candidate| party_members.contains(candidate)).collect();
    if eligible.is_empty() {
        eligible.extend(party_members.iter().cloned());
    }
    let snapshot = {
        let campaign = campaign_id.to_string();
        let snapshot_state = state.clone();
        let heroes = eligible.clone();
        crate::core::blocking(move || crate::access::party_voter_snapshot(&accounts, &campaign, &snapshot_state, &heroes)).await??
    };
    let mut decision_options = Map::new();
    decision_options.insert("eligibleHeroIds".into(), js::strings_value(eligible));
    decision_options.insert("eligibleVoterIds".into(), snapshot.get("eligibleVoterIds").cloned().unwrap_or(Value::Null));
    decision_options.insert("voterByHeroId".into(), snapshot.get("voterByHeroId").cloned().unwrap_or(Value::Null));
    if let Some(policy) = state.get("partyDecisionPolicy") {
        decision_options.insert("policy".into(), policy.clone());
    }
    let opened = sk_memory::party_decision::party_decision_opened_event(interaction, None, &Value::Object(decision_options)).map_err(party_failure)?;
    let journal = HookedJournal(&core.events);
    let executor = AuthoritativeExecutor::new(&journal);
    let committed = executor.commit_derived(DerivedRequest::events(campaign_id, &idempotency_key, Producer::PartyDecision, vec![opened])).map_err(executor_failure)?;
    let Some(committed) = committed else { return Ok(None) };
    persist_authoritative_projection(&core, campaign_id, &committed.commit.state, &committed.commit.events, None, PersistOptions::default())
}

/// `expirePartyDecisionIfNeeded(campaignId, now)` (3657–3671): истечение
/// голосования; события пересобираются против свежего состояния на каждой
/// попытке. `None` — истекать нечему.
pub fn expire_party_decision_if_needed(core: &GameCore, campaign_id: &str, now_ms: i64) -> Result<Option<Executed>, Failure> {
    let loaded = core.events.load(campaign_id, &LoadOptions::default())?;
    let interaction = loaded.state.get("agentInteraction");
    let interaction_id = js::s(interaction.and_then(|value| value.get("id")));
    let expires_at = js::s(interaction.and_then(|value| value.get("expiresAt")));
    if !expiry_pending(&loaded.state, now_ms)? {
        return Ok(None);
    }
    let key = format!("party-decision-expire:{interaction_id}:{expires_at}");
    let derive = move |state: &Value, _loaded: &sk_store::Loaded| -> Result<Vec<Value>, sk_core::RuleError> {
        let expiry = sk_memory::party_decision::party_decision_expiry_events(state, Some(now_ms as f64)).map_err(party_rule)?;
        Ok(expiry.get("events").and_then(Value::as_array).cloned().unwrap_or_default())
    };
    commit_derived_with(core, campaign_id, &key, Producer::PartyDecision, &derive)
}

fn commit_derived_with(core: &GameCore, campaign_id: &str, key: &str, producer: Producer, derive: &DeriveEvents<'_>) -> Result<Option<Executed>, Failure> {
    let journal = HookedJournal(&core.events);
    let executor = AuthoritativeExecutor::new(&journal);
    let request = DerivedRequest { campaign_id, idempotency_key: key, events: None, derive_events: Some(derive), producer: Some(producer), derived_from: Vec::new(), metadata: Value::Null, derive_metadata: None };
    executor.commit_derived(request).map_err(executor_failure)
}

/// `reconcilePartyDecisionPresence(campaignId)` (3673–3696): ушедшие
/// голосующие воздерживаются (политика `disconnectAction: 'abstain'`), решение
/// может завершиться; присутствие — [`crate::streams::Presence`] ядра.
pub fn reconcile_party_decision_presence(core: &Rc<GameCore>, campaign_id: &str) -> Result<Option<Executed>, Failure> {
    let loaded = core.events.load(campaign_id, &LoadOptions::default())?;
    let Some(interaction) = loaded.state.get("agentInteraction").filter(|value| js::truthy(Some(value))) else { return Ok(None) };
    let abstain = loaded.state.get("partyDecisionPolicy").and_then(|policy| policy.get("disconnectAction")).and_then(Value::as_str) == Some("abstain");
    if interaction.get("status").and_then(Value::as_str) != Some("open") || !abstain {
        return Ok(None);
    }
    let connected: Vec<String> = core.streams.connected_hero_ids(campaign_id).into_iter().collect();
    let active = sk_memory::party_decision::party_decision_active_voter_ids(interaction, Some(&js::strings_value(connected))).map_err(party_failure)?;
    let input = json!({ "activeVoterIds": active });
    let presence = sk_memory::party_decision::party_decision_presence_events(&loaded.state, &input).map_err(party_failure)?;
    if presence.get("events").and_then(Value::as_array).is_none_or(Vec::is_empty) {
        return Ok(None);
    }
    let id = js::string(interaction.get("id"));
    let mut sorted: Vec<Value> = active.iter().cloned().map(Value::String).collect();
    js::default_sort(&mut sorted);
    let joined = sorted.iter().map(|value| js::s(Some(value))).collect::<Vec<_>>().join(",");
    let active_key = if joined.is_empty() { "none".to_string() } else { joined };
    let key = format!("party-decision-presence:{id}:{active_key}");
    let derive = move |state: &Value, _loaded: &sk_store::Loaded| -> Result<Vec<Value>, sk_core::RuleError> {
        let presence = sk_memory::party_decision::party_decision_presence_events(state, &input).map_err(party_rule)?;
        Ok(presence.get("events").and_then(Value::as_array).cloned().unwrap_or_default())
    };
    let Some(committed) = commit_derived_with(core, campaign_id, &key, Producer::Presence, &derive)? else { return Ok(None) };
    persist_authoritative_projection(core, campaign_id, &committed.commit.state, &committed.commit.events, None, PersistOptions::default())?;
    Ok(Some(committed))
}

/// Хук «проекция записана» — бывший `onRoomSaved` (`store.mjs:438–470`).
/// Подписчики: рассылка (С9), координатор боя и часы мира (С17), зацепки
/// героев (С17). Хук — фоновая задача ядра: он получает свои копии и
/// исполняется **после** текущего отрезка коммитящего задания, как
/// `queueMicrotask` (`index.mjs:2784, 2830–2836, 2882, 4269`).
pub type ProjectionSavedHook = fn(Rc<GameCore>, String, Room) -> LocalFuture<()>;

/// `onRoomSaved(listener)`: подписать хук на каждую запись комнаты.
pub fn subscribe_projection_saved(core: &GameCore, hook: ProjectionSavedHook) {
    core.room_hooks.borrow_mut().push(hook);
}

/// Оповестить подписчиков о записанной проекции: каждый хук ставится
/// [`crate::core::spawn_in_context`] (учёт, настройки ИИ кампании
/// постановщика) и синхронно ничего не делает — займы `RefCell`
/// вызывающего не пересекаются с хуками. Запись комнаты зовёт её сама
/// ([`crate::room::save_room`]) со списком из [`subscribe_projection_saved`].
pub fn on_projection_saved(core: &Rc<GameCore>, campaign_id: &str, room: &Room, hooks: &[ProjectionSavedHook]) -> Result<(), CoreError> {
    for hook in hooks {
        let future = hook(core.clone(), campaign_id.to_string(), room.clone());
        crate::core::spawn_in_context(async move {
            let _span = sk_store::perf::span("hook.projection_saved");
            future.await
        })?;
    }
    Ok(())
}

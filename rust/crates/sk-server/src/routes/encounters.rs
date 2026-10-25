//! С18.3: сборка встречи `POST /api/campaigns/:id/encounters/assemble`
//! (`server/index.mjs` 5306–5447, отпечатки встречи 995–1022).
//!
//! Встреча ведущего от `EncounterAssembler`: белый список полей тела (5318)
//! → ключ идемпотентности → команда `CreateEncounter` с отпечатком
//! (`encounterCommandFingerprint`) → сверка повтора ключа → предпросмотр
//! сборщика по авторитетному состоянию с той же занятостью клеток, стенами и
//! окнами, что у Rules Engine (5349–5368) → предупреждение «смертельно» в
//! летопись до точки невозврата → `GameOrchestrator::handle` с
//! `CreateEncounter` и `StartCombat` → сверка отпечатка итога → ходы врагов до
//! хода героя (`settleCombatContinuation`) → вводка ведущего
//! (`renderEncounterOpening`, повтор ключа отдаёт записанную) → проекция в
//! комнату → ответ зрителю (`turnResultForViewer`).
//!
//! Клиент не задаёт ни врагов, ни чисел, ни клеток появления: в команду идут
//! только `difficulty`, `theme`, `seed` и версия, а движок повторяет сборку
//! сам перед событием (`assemble_encounter_from_state`, инвариант «враг
//! встречи появляется по эту сторону дверей и окон от отряда» держит
//! `sk-encounters`). Предпросмотр нужен только для предупреждения и как
//! запасной `encounter_proposal`.
//!
//! Как в JS: `requireAdmin` — вне `try` (401/403 границы); комната, лимит
//! 30, тело, ключ — внутри: ранние ответы (404 `CAMPAIGN_NOT_FOUND`, 429
//! `ENCOUNTER_ASSEMBLY_RATE_LIMITED`, 400 `IDEMPOTENCY_KEY_REQUIRED`) идут
//! мимо `catch`, исключения — по таблице `catch` (409 конфликты, 403 отказы
//! прав, прочее — 400 с текстом ошибки). Проверка «тело — объект»
//! (`INVALID_ENCOUNTER_INPUT`, 5316) до ответа не доходит: `readBody` отказывает
//! сам (`INVALID_JSON_BODY`). Неверная версия — код торговца
//! `INVALID_MERCHANT_LIFECYCLE_COMMAND` (общий `lifecycleInteger`, как в JS).
//!
//! Отклонения (как у С14, С18.1, С18.2): герои ведущего (`campaignHeroIds`)
//! узнаются в [`blocking`] до задания ядра, то есть до сверки повтора ключа.
//! Различие видно только при сбое хранилища аккаунтов.
//! `settleCombatContinuation` — минимальная из `routes::commands` (С17
//! заменит вызовом координатора последствий).

use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;

use axum::http::StatusCode;
use serde_json::{json, Map, Value};
use sk_core::js;
use sk_orchestrator::autonomous_orchestrator::OrchestratorError;
use sk_orchestrator::game_orchestrator::HandleInput;
use sk_store::LoadOptions;

use crate::access::{campaign_hero_values, require_admin};
use crate::command_fingerprints::DuplicateLookup;
use crate::command_guard::policy_error;
use crate::core::{blocking, GameCore};
use crate::dispatch::{Matcher, Route, RouteCtx, RouteFuture};
use crate::error::{ApiError, Failure};
use crate::http::json;
use crate::journal::{append_room_journal, combat_message_id, recent_narrator_texts};
use crate::merchant_guard::{js_number, js_string, js_string_or_empty, lifecycle_integer_default, slice_utf16, utf16_len};
use crate::orchestration::orchestration;
use crate::projection::{latest_campaign_state, persist_authoritative_projection, PersistOptions};
use crate::room::{get_room, Room};
use crate::routes::campaigns::Caught;
use crate::state::AppState;

pub fn routes() -> Vec<Route> {
    // `/^\/api\/campaigns\/([A-Za-z0-9-]+)\/encounters\/assemble$/` и `POST` (5306–5307).
    vec![Route::post(5308, Matcher::path_template("/api/campaigns/{id}/encounters/assemble"), assemble)]
}

/// Коды 409 (5444).
const CONFLICT_CODES: &[&str] = &["STATE_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "ENCOUNTER_ALREADY_PRESENT", "ENCOUNTER_DURING_COMBAT"];
/// Коды 403 (5445).
const FORBIDDEN_CODES: &[&str] = &["ENCOUNTER_MANAGEMENT_FORBIDDEN", "ACTOR_FORBIDDEN"];
/// Ключи тела (5318).
const ALLOWED_KEYS: &[&str] = &["expected_state_version", "difficulty", "theme", "seed", "idempotency_key"];

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

fn array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn event_type(event: &Value) -> Option<&str> {
    get(Some(event), "event_type").and_then(Value::as_str)
}

fn orchestrator_failure(error: OrchestratorError) -> Failure {
    Failure::new(error.message(), error.code())
}

fn reply(status: StatusCode, message: &str, code: &str) -> Caught {
    Caught::Reply(ApiError::coded(status, message, code))
}

// --- отпечатки встречи (995–1022) ----------------------------------------------

/// `encounterCommandFingerprint(command)` (995–1003): SHA-256 строки
/// `JSON.stringify({ type, difficulty, theme, seed })`.
pub fn encounter_command_fingerprint(command: &Value) -> Result<String, Failure> {
    let field = |key: &str| js_string_or_empty(get(Some(command), key));
    let semantic = json!({
        "type": "CreateEncounter",
        "difficulty": field("difficulty")?,
        "theme": field("theme")?,
        "seed": field("seed")?,
    });
    Ok(sk_core::hash::sha256_hex(js::stringify(&semantic).as_bytes()))
}

/// `payload?.request_fingerprint` событий `EncounterCreated`, без пустых.
fn created_fingerprints(events: Option<&Value>) -> HashSet<String> {
    array(events)
        .iter()
        .filter(|event| event_type(event) == Some("EncounterCreated"))
        .map(|event| get(get(Some(event), "payload"), "request_fingerprint"))
        .filter(|value| js::truthy(*value))
        .map(js::string)
        .collect()
}

/// `assertEncounterIdempotency(campaignId, idempotencyKey, command)` (1005–1014).
pub fn assert_encounter_idempotency(journal: &dyn DuplicateLookup, campaign_id: &str, idempotency_key: &str, command: &Value) -> Result<(), Failure> {
    let Some(duplicate) = journal.get_by_idempotency_key(campaign_id, idempotency_key)? else { return Ok(()) };
    let fingerprints = created_fingerprints(get(Some(&duplicate), "events"));
    if fingerprints.len() != 1 || !fingerprints.contains(&encounter_command_fingerprint(command)?) {
        return Err(policy_error("Этот ключ идемпотентности уже использован для другого столкновения", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

/// `assertEncounterResultFingerprint(result, command)` (1016–1021): первое
/// `EncounterCreated` итога несёт отпечаток команды.
pub fn assert_encounter_result_fingerprint(result: &Value, command: &Value) -> Result<(), Failure> {
    let event = array(get(Some(result), "mechanics")).iter().find(|candidate| event_type(candidate) == Some("EncounterCreated"));
    let matches = match event {
        Some(event) => js_string_or_empty(get(get(Some(event), "payload"), "request_fingerprint"))? == encounter_command_fingerprint(command)?,
        None => false,
    };
    if !matches {
        return Err(policy_error("Результат столкновения не соответствует исходному запросу", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

// --- маршрут -------------------------------------------------------------------

fn assemble(ctx: &mut RouteCtx) -> RouteFuture<'_> {
    Box::pin(async move {
        let admin = require_admin(ctx).await?;
        let campaign_id = ctx.param(0).to_string();
        match assemble_try(ctx, admin, campaign_id).await {
            Ok(body) => Ok(json(StatusCode::OK, &body)),
            Err(Caught::Reply(error)) => Err(error),
            Err(Caught::Thrown(failure)) => {
                let groups: [(&[&str], StatusCode); 2] = [(CONFLICT_CODES, StatusCode::CONFLICT), (FORBIDDEN_CODES, StatusCode::FORBIDDEN)];
                Err(failure.respond_by(&groups, StatusCode::BAD_REQUEST))
            }
        }
    })
}

/// Что узнано на стороне HTTP до задания ядра.
struct Assembly {
    campaign_id: String,
    admin: Value,
    body: Value,
    room: Room,
    idempotency_key: String,
    hero_ids: Vec<Value>,
}

/// `String(body.idempotency_key ?? req.headers['x-idempotency-key'] ?? '').trim()`;
/// пустой или длиннее 200 — ранний ответ 400.
fn idempotency_key(body: &Value, ctx: &RouteCtx) -> Result<String, Caught> {
    let header = crate::http::has_header(&ctx.headers, "x-idempotency-key").then(|| Value::String(ctx.header("x-idempotency-key")));
    let raw = js_string_or_empty(nullish(body.get("idempotency_key"), header.as_ref()))?;
    let key = sk_core::text::trim(&raw).to_string();
    if key.is_empty() || utf16_len(&key) > 200 {
        return Err(reply(StatusCode::BAD_REQUEST, "Нужен X-Idempotency-Key или idempotency_key длиной до 200 символов", "IDEMPOTENCY_KEY_REQUIRED"));
    }
    Ok(key)
}

/// Тело `try` до задания ядра (5309–5322).
async fn assemble_try(ctx: &mut RouteCtx, admin: Value, campaign_id: String) -> Result<Value, Caught> {
    let state = ctx.state.clone();
    let code = campaign_id.clone();
    let room = state.core.call(move |core| Box::pin(async move { get_room(&core, &code) })).await??;
    if !js::truthy(room.state.as_ref()) {
        return Err(reply(StatusCode::NOT_FOUND, "Кампания не найдена", "CAMPAIGN_NOT_FOUND"));
    }
    if state.limits.exceeds_rate(&format!("encounter-assemble:{}", js::string(admin.get("id"))), 30, None) {
        return Err(reply(StatusCode::TOO_MANY_REQUESTS, "Слишком много запросов сборки столкновений", "ENCOUNTER_ASSEMBLY_RATE_LIMITED"));
    }
    let body = ctx.json_body().await?;
    if !body.is_object() {
        return Err(policy_error("Параметры столкновения должны быть объектом", "INVALID_ENCOUNTER_INPUT").into());
    }
    if body.as_object().is_some_and(|map| map.keys().any(|key| !ALLOWED_KEYS.contains(&key.as_str()))) {
        return Err(policy_error("Запрос столкновения содержит неизвестное поле", "UNEXPECTED_ENCOUNTER_FIELD").into());
    }
    let idempotency_key = idempotency_key(&body, ctx)?;
    let accounts = state.accounts.clone();
    let (checked_admin, code) = (admin.clone(), campaign_id.clone());
    let hero_ids = blocking(move || campaign_hero_values(&accounts, &checked_admin, &code)).await??;
    let job = Assembly { campaign_id, admin, body, room, idempotency_key, hero_ids };
    let app = state.clone();
    Ok(state.core.call(move |core| Box::pin(async move { run(core, app, job).await })).await??)
}

/// `String(value ?? fallback)`.
fn string_or(value: Option<&Value>, fallback: &str) -> Result<String, Failure> {
    match value {
        Some(value) if !value.is_null() => js_string(Some(value)),
        _ => Ok(fallback.to_string()),
    }
}

/// Ключ клетки `${Number(x)},${Number(y)}` (NaN — `"NaN"`, как в JS).
fn cell_key(x: f64, y: f64) -> String {
    format!("{},{}", js::f64_string(x), js::f64_string(y))
}

/// `authoritative.mechanics?.positions?.[id] ?? fallback`.
fn position_of<'a>(state: &'a Value, id: &str, fallback: &'a Value) -> &'a Value {
    match get(get(get(Some(state), "mechanics"), "positions"), id) {
        Some(position) if !position.is_null() => position,
        _ => fallback,
    }
}

/// `TypeError` V8 на `undefined.key`.
fn undefined_read(key: &str) -> Failure {
    Failure::new(format!("Cannot read properties of undefined (reading '{key}')"), None)
}

/// Живые герои отряда с уровнем и позицией (5341–5345).
fn preview_party(state: &Value) -> Result<Vec<Value>, Failure> {
    let members = array(state.get("partyMemberIds"));
    let players = state.get("players").and_then(Value::as_array);
    let member_ids: HashSet<String> = if !members.is_empty() {
        members.iter().map(|id| js_string(Some(id))).collect::<Result<_, _>>()?
    } else {
        players.ok_or_else(|| undefined_read("map"))?.iter().map(|player| js_string(get(Some(player), "id"))).collect::<Result<_, _>>()?
    };
    let mut party = Vec::new();
    for player in players.ok_or_else(|| undefined_read("filter"))? {
        let id = js_string(get(Some(player), "id"))?;
        if !member_ids.contains(&id) || !(js_number(get(Some(player), "hp"))? > 0.0) {
            continue;
        }
        let position = position_of(state, &id, player);
        let level = js_number(get(Some(player), "level"))?;
        let level = if level.is_finite() && level.fract() == 0.0 && level.abs() <= 9_007_199_254_740_991.0 { level } else { 1.0 };
        party.push(json!({
            "id": id,
            "level": js::num(level.min(20.0).max(1.0)),
            "x": js::num(js_number(get(Some(position), "x"))?),
            "y": js::num(js_number(get(Some(position), "y"))?),
        }));
    }
    Ok(party)
}

/// Занятые клетки предпросмотра — тот же расчёт, что у Rules Engine (5349–5361).
fn preview_occupied_cells(state: &Value) -> Result<HashSet<String>, Failure> {
    let mut occupied = HashSet::new();
    let actors = array(state.get("enemies")).iter().chain(array(state.get("actors")).iter());
    for actor in actors {
        let alive = js::truthy(Some(actor)) && get(Some(actor), "alive") != Some(&Value::Bool(false));
        let hp = match get(Some(actor), "hp") {
            Some(value) if !value.is_null() => js_number(Some(value))?,
            _ => 1.0,
        };
        if !alive || !(hp > 0.0) {
            continue;
        }
        let id = js_string(get(Some(actor), "id"))?;
        let position = position_of(state, &id, actor);
        occupied.insert(cell_key(js_number(get(Some(position), "x"))?, js_number(get(Some(position), "y"))?));
    }
    for entity in array(state.get("entities")) {
        if js_string(get(Some(entity), "kind"))? == "enemy" {
            occupied.insert(cell_key(js_number(get(Some(entity), "x"))?, js_number(get(Some(entity), "y"))?));
        }
    }
    Ok(occupied)
}

/// Клетки сцены для сборщика: тип, открытость, черта, занятость, стены и окна (5362–5370).
fn preview_cells(state: &Value, occupied: &HashSet<String>) -> Result<Vec<Value>, Failure> {
    let mut cells = Vec::new();
    for cell in array(get(state.get("scene"), "cells")) {
        if cell.is_null() {
            return Err(Failure::new("Cannot read properties of null (reading 'x')", None));
        }
        let x = js_number(get(Some(cell), "x"))?;
        let y = js_number(get(Some(cell), "y"))?;
        let mut entry = Map::new();
        entry.insert("x".into(), js::num(x));
        entry.insert("y".into(), js::num(y));
        entry.insert("type".into(), Value::String(string_or(get(Some(cell), "type"), "floor")?));
        entry.insert("revealed".into(), Value::Bool(get(Some(cell), "revealed") == Some(&Value::Bool(true))));
        if let Some(feature) = get(Some(cell), "feature").filter(|feature| !feature.is_null()) {
            entry.insert("feature".into(), Value::String(js_string(Some(feature))?));
        }
        if occupied.contains(&cell_key(x, y)) {
            entry.insert("occupied".into(), Value::Bool(true));
        }
        let walls = sk_encounters::encounter_assembler::encounter_barrier_sides(Some(cell));
        if !walls.is_empty() {
            entry.insert("walls".into(), Value::String(walls.into()));
        }
        cells.push(Value::Object(entry));
    }
    Ok(cells)
}

/// `assembleEncounter(...)`: отказ сборщика — исключение с его кодом.
fn assemble_preview(input: &Value) -> Result<Value, Failure> {
    sk_encounters::encounter_assembler::assemble_encounter(Some(input)).map_err(|error| {
        let message = error.to_string();
        Failure::new(message, error.code())
    })
}

/// Строка-опора повествования боя: «Звенит сталь. Первый ход — за …» после
/// вводки ведущего не звучит (5417–5418).
fn without_opening_cue(text: &str) -> String {
    let cue = sk_core::re!(r"^(?:Звенит сталь\.|Сталь покидает ножны\.|Медлить больше некогда\.)\s*(?:Первый ход — за [^.]+\.\s*)?", "u");
    sk_core::text::replace_first(cue, text, "")
}

/// Задание ядра (5323–5442).
async fn run(core: Rc<GameCore>, app: Arc<AppState>, job: Assembly) -> Result<Value, Failure> {
    let campaign_id = job.campaign_id.as_str();
    let idempotency_key = job.idempotency_key.as_str();
    let body = &job.body;
    let authoritative = latest_campaign_state(&core, campaign_id, job.room.state.as_ref())?;
    let expected_state_version = lifecycle_integer_default(body.get("expected_state_version"), "expected_state_version")?;
    let difficulty = string_or(body.get("difficulty"), "medium")?;
    let theme = string_or(body.get("theme"), "generic")?;
    let default_seed = sk_core::hash::sha256_hex(format!("{campaign_id}\0{idempotency_key}").as_bytes());
    let seed = slice_utf16(&string_or(body.get("seed"), &default_seed)?, 120);
    let mut command = json!({
        "command_type": "CreateEncounter",
        "expected_state_version": expected_state_version,
        "difficulty": difficulty,
        "theme": theme,
        "seed": seed,
    });
    let fingerprint = encounter_command_fingerprint(&command)?;
    if let Some(map) = command.as_object_mut() {
        map.insert("request_fingerprint".into(), Value::String(fingerprint));
    }
    assert_encounter_idempotency(core.events.as_ref(), campaign_id, idempotency_key, &command)?;

    // Предпросмотр по авторитетному состоянию: Rules Engine повторяет вывод
    // перед событием, ни HTTP, ни агент не подставят ни листа, ни числа, ни
    // клетки появления.
    let party = preview_party(&authoritative)?;
    let occupied = preview_occupied_cells(&authoritative)?;
    let cells = preview_cells(&authoritative, &occupied)?;
    let preview_input = json!({
        "scene": { "cells": cells },
        "party": party,
        "difficulty": difficulty,
        "theme": theme,
        "seed": seed,
    });
    let proposal_preview = assemble_preview(&preview_input)?;
    // Точка невозврата — StartCombat ниже: предупреждение уходит до него.
    if get(Some(&proposal_preview), "difficulty").and_then(Value::as_str) == Some("deadly") {
        let warning = json!({
            "id": format!("deadly-warning-{campaign_id}-{idempotency_key}"),
            "speaker": "system",
            "author": "Оценка угрозы",
            "text": sk_encounters::encounter_assembler::DEADLY_ENCOUNTER_WARNING,
        });
        append_room_journal(&core, campaign_id, &[warning])?;
    }
    // `String(party[0]?.id ?? authoritative.activePlayerId ?? '')`.
    let actor_id = js_string_or_empty(nullish(get(party.first(), "id"), authoritative.get("activePlayerId")))?;
    let input = json!({
        "state": job.room.state.clone().unwrap_or(Value::Null),
        "campaignId": campaign_id,
        "playerId": actor_id,
        "message": "EncounterAssembler создаёт столкновение и запускает инициативу",
        "commands": [command.clone(), { "command_type": "StartCombat", "actor_id": actor_id, "server_authoritative": true }],
        "idempotencyKey": idempotency_key,
        "user": job.admin,
        "allowedActorIds": job.hero_ids,
    });
    let set = orchestration(&core, &app)?;
    let mut result = set.game.handle(HandleInput::new(input)).await.map_err(orchestrator_failure)?;
    assert_encounter_result_fingerprint(&result, &command)?;
    let original = nullish(result.get("state_version"), get(result.get("authoritative_state"), "state_version")).cloned().unwrap_or(Value::from(0));
    let original_version = js_number(Some(&original))?;
    // С17: стадия combat-continuation координатора последствий ядра.
    let npc_turns = crate::clocks::settle_combat_continuation(&core, campaign_id, true).await?.turns;
    let latest = core.events.load(campaign_id, &LoadOptions::default())?;
    let subsequent = if (latest.state_version as f64) > original_version { core.events.get_events(campaign_id, original_version as i64, Some(latest.state_version))? } else { Vec::new() };
    let identity = |event: &Value| match get(Some(event), "event_id") {
        Some(id) if !id.is_null() => js::string(Some(id)),
        _ => format!("{}:{}", js::string(get(Some(event), "state_version_after")), js::string(get(Some(event), "event_type"))),
    };
    let mut seen = HashSet::new();
    let mechanics: Vec<Value> = array(result.get("mechanics")).iter().cloned().chain(subsequent).filter(|event| seen.insert(identity(event))).collect();
    let fallback = js_string_or_empty(result.get("narration"))?;
    let options = json!({ "npcTurns": npc_turns });
    let combat_narration_text = sk_narration::combat_narration::tactical_narration_or_text(&mechanics, &latest.state, &fallback, Some(&options)).map_err(|error| Failure::new(error.to_string(), None))?;
    // Начало схватки словами ведущего вместо строки «Из укрытий выскакивают …»;
    // повтор ключа отдаёт записанный текст, а не зовёт модель снова.
    let opening_id = combat_message_id(idempotency_key);
    let current = get_room(&core, campaign_id)?;
    let messages = array(current.state.as_ref().and_then(|state| state.get("messages")));
    let stored_opening = messages.iter().find(|message| js::string(get(Some(message), "id")) == opening_id).and_then(|message| get(Some(message), "text")).filter(|text| js::truthy(Some(text))).map(|text| js::s(Some(text)));
    let created_event = mechanics.iter().find(|event| event_type(event) == Some("EncounterCreated")).cloned();
    let mut narration = stored_opening.clone().unwrap_or_else(|| combat_narration_text.clone());
    if let (None, Some(created)) = (&stored_opening, &created_event) {
        let mut viewer = Map::new();
        viewer.insert("playerId".into(), Value::String(actor_id.clone()));
        viewer.insert("partyIds".into(), Value::Array(job.hero_ids.clone()));
        viewer.insert("isPartyMember".into(), Value::Bool(true));
        if let Some(role) = job.admin.get("role") {
            viewer.insert("role".into(), role.clone());
        }
        let recent: Vec<Value> = recent_narrator_texts(current.state.as_ref(), 6).into_iter().map(Value::String).collect();
        let last_player = messages.iter().rev().find(|message| get(Some(message), "speaker").and_then(Value::as_str) == Some("player"));
        let last_player_action = js_string_or_empty(get(last_player, "text"))?;
        let opening_input = json!({
            "events": mechanics,
            "state": latest.state,
            "viewer": Value::Object(viewer),
            "recentNarrations": recent,
            "lastPlayerAction": last_player_action,
        });
        // `.catch(() => null)`.
        let opening = set.creative.render_encounter_opening(&opening_input).await.ok().flatten();
        let opening_text = get(opening.as_ref(), "narration").filter(|text| js::truthy(Some(text)));
        if let Some(text) = opening_text {
            let intro = sk_narration::combat_narration::encounter_intro(created, &latest.state);
            let rest = if !intro.is_empty() && combat_narration_text.contains(&intro) {
                sk_core::text::trim(&combat_narration_text.replacen(&intro, "", 1)).to_string()
            } else {
                combat_narration_text.clone()
            };
            // Очерёдность видна на панели хода — после вводки она не звучит.
            let rest = without_opening_cue(&rest);
            narration = [sk_core::text::trim(&js::s(Some(text))).to_string(), rest].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
        }
    }
    if let Some(map) = result.as_object_mut() {
        map.insert("state_version".into(), Value::from(latest.state_version));
        map.insert("authoritative_state".into(), latest.state.clone());
        map.insert("mechanics".into(), Value::Array(mechanics.clone()));
        map.insert("npc_turns".into(), Value::Array(npc_turns));
        map.insert("narration".into(), Value::String(narration.clone()));
    }
    let narration_message = (!narration.is_empty()).then(|| json!({ "id": combat_message_id(idempotency_key), "text": narration, "turnConsumed": false }));
    let projected = persist_authoritative_projection(&core, campaign_id, &latest.state, &mechanics, narration_message.as_ref(), PersistOptions::default())?;
    let response_state = projected.as_ref().and_then(|room| room.state.clone()).filter(|state| !state.is_null()).unwrap_or(latest.state);
    let encounter = mechanics.iter().find(|event| event_type(event) == Some("EncounterCreated")).and_then(|event| get(get(Some(event), "payload"), "encounter")).filter(|encounter| !encounter.is_null()).cloned();
    if let Some(map) = result.as_object_mut() {
        map.insert("authoritative_state".into(), response_state);
        map.insert("encounter_proposal".into(), encounter.unwrap_or(proposal_preview));
        map.insert("room_version".into(), Value::from(projected.as_ref().map_or(job.room.version, |room| room.version)));
    }
    let actor = Value::String(actor_id);
    let reply = sk_projection::viewer_projection::turn_result_for_viewer(Some(&result), Some(&job.admin), Some(&actor)).map_err(Failure::from)?;
    Ok(reply.unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_matches_js_json_stringify() {
        // `createHash('sha256').update('{"type":"CreateEncounter","difficulty":"easy","theme":"beasts","seed":"s"}')`.
        let command = json!({ "command_type": "CreateEncounter", "difficulty": "easy", "theme": "beasts", "seed": "s" });
        let expected = sk_core::hash::sha256_hex(br#"{"type":"CreateEncounter","difficulty":"easy","theme":"beasts","seed":"s"}"#);
        assert_eq!(encounter_command_fingerprint(&command).ok(), Some(expected));
    }

    #[test]
    fn opening_cue_is_dropped() {
        assert_eq!(without_opening_cue("Звенит сталь. Первый ход — за Волк 1. Волк кусает."), "Волк кусает.");
        assert_eq!(without_opening_cue("Волк кусает. Звенит сталь."), "Волк кусает. Звенит сталь.");
    }
}

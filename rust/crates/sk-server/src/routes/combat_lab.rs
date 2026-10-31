//! С5: боевой стенд администратора — `/api/admin/combat-lab/*`
//! (`server/routes/combat-lab-routes.mjs`, подключение — `index.mjs:3959`,
//! сборка реестра — 340–344).
//!
//! Один маршрут [`Route::pass`] на префикс: обработчик проверяет путь и метод
//! сам, в порядке JS, а нераспознанный путь под префиксом (и неподходящий
//! метод) проваливается дальше по таблице (`return false`, поправка рецензии
//! №9) — до 404 «API endpoint не найден». 405 — только у `DELETE …/report`.
//!
//! - `GET scenarios`, `GET catalog`, `POST encounter/assess|generate`;
//! - `GET runs` — идущий прогон, `POST runs` — запуск (202 `{ id }`);
//! - `GET runs/:id[?after=N]` — прогон и кадры после `N`, `DELETE runs/:id`
//!   — отмена с ожиданием конца прогона (202), `GET runs/:id/report` —
//!   отчёт вложением (`Content-Disposition`).
//!
//! Реестр — `sk_tactics::combat_lab::CombatLabRuns`, по одному на процесс
//! сервера (`AppState`): JS держит один `combatLabRuns` на процесс. Реестр
//! создаётся при первом запросе и живёт в таблице этого модуля, ключ —
//! `AppState` (поле в `AppState` не заводится: реестру нужен доступ к ядру
//! из блокирующих потоков, а слабая ссылка на `AppState` есть только после
//! его сборки). Прогон боя — [`runner::LabRunner`] в своём потоке (в JS —
//! промис на цикле событий): синхронный бой на потоке ядра остановил бы
//! все кампании. Кампании-источники (`loadCampaign`, `listRoomCodes`,
//! `getRoom`) реестр читает заданиями ядра из блокирующего потока; поэтому
//! каталог, оценка, генерация, запуск и отмена идут через
//! [`crate::core::blocking`].

mod runner;

use std::sync::{Arc, Mutex, PoisonError, Weak};

use axum::http::{HeaderValue, Method, StatusCode};
use serde_json::{json, Value};
use sk_core::js;
use sk_store::LoadOptions;
use sk_tactics::combat_lab::{CombatLabRuns, CombatLabRunsOptions, CreateError};
use sk_tactics::combat_lab_setup::{CampaignRooms, CombatLabSetupError};

use crate::access::require_admin;
use crate::core::blocking;
use crate::dispatch::{Matcher, Methods, PassFuture, Route, RouteCtx};
use crate::error::{ApiError, ApiResult};
use crate::http::{json, BodyError};
use crate::state::{AppState, Shared};

const PREFIX: &str = "/api/admin/combat-lab/";
const RUNS: &str = "/api/admin/combat-lab/runs/";
const RUN_NOT_FOUND: &str = "Прогон боевого стенда не найден";

pub fn routes() -> Vec<Route> {
    // `if (!requestPath.startsWith('/api/admin/combat-lab/')) return false`.
    vec![Route::pass(3972, Methods::Any, Matcher::path_prefix(PREFIX), combat_lab)]
}

// --- реестр процесса ----------------------------------------------------------

/// Реестры серверов процесса (в тестах их несколько).
static LABS: Mutex<Vec<(Weak<AppState>, Arc<CombatLabRuns>)>> = Mutex::new(Vec::new());

/// `combatLabRuns` этого сервера (`index.mjs:341–344`).
fn lab(state: &Shared) -> Arc<CombatLabRuns> {
    let mut labs = LABS.lock().unwrap_or_else(PoisonError::into_inner);
    labs.retain(|(app, _)| app.strong_count() > 0);
    if let Some((_, lab)) = labs.iter().find(|(app, _)| std::ptr::eq(app.as_ptr(), Arc::as_ptr(state))) {
        return Arc::clone(lab);
    }
    let app = Arc::downgrade(state);
    let mut options = CombatLabRunsOptions::new(Arc::new(runner::LabRunner));
    options.rooms = Arc::new(CoreRooms { app: app.clone() });
    // `loadCampaign: async (id) => (await eventStore.load(String(id).toUpperCase())).state`.
    options.load_campaign = Some(Arc::new(move |campaign_id: &str| {
        let campaign_id = campaign_id.to_uppercase();
        core_job(&app, move |core| core.events.load(&campaign_id, &LoadOptions::default()).map(|loaded| Some(std::sync::Arc::unwrap_or_clone(loaded.state))).map_err(|error| setup_error(&error.message, Some(error.code))))
    }));
    // `chooseCommand: planHeroCombatCommand`: прогон своего боя зовёт его сам
    // (`runner`), здесь — признак и та же функция для вызывающих реестр.
    options.choose_command = Some(Arc::new(|view: &Value, actor_id: &str| sk_tactics::party_tactics::plan_hero_combat_command(view, actor_id).map_or(Value::Null, |step| step.to_json())));
    let lab = Arc::new(CombatLabRuns::new(options));
    labs.push((Arc::downgrade(state), Arc::clone(&lab)));
    lab
}

fn setup_error(message: &str, code: Option<&str>) -> CombatLabSetupError {
    CombatLabSetupError::other("Error", message, code.map(str::to_string))
}

/// Синхронное задание ядра из блокирующего потока (не с потока ядра).
fn core_job<R: Send + 'static>(app: &Weak<AppState>, job: impl FnOnce(&crate::core::GameCore) -> Result<R, CombatLabSetupError> + Send + 'static) -> Result<R, CombatLabSetupError> {
    let app = app.upgrade().ok_or_else(|| setup_error("игровое ядро остановлено", None))?;
    let reply = runner::block_on(app.core.call(move |core| Box::pin(async move { job(&core) })));
    reply.map_err(|error| setup_error(&error.to_string(), None))?
}

/// Комнаты для кампаний-источников стенда: `listRoomCodes()` и `getRoom(code).state`.
struct CoreRooms {
    app: Weak<AppState>,
}

impl CampaignRooms for CoreRooms {
    fn room_codes(&self) -> Result<Vec<String>, CombatLabSetupError> {
        core_job(&self.app, |core| crate::room::list_room_codes(core).map_err(|error| setup_error(&error.message, error.code.as_deref())))
    }

    fn room_state(&self, code: &str) -> Result<Option<Value>, CombatLabSetupError> {
        let code = code.to_string();
        core_job(&self.app, move |core| crate::room::get_room(core, &code).map(|room| room.state).map_err(|error| setup_error(&error.message, error.code.as_deref())))
    }
}

// --- ответы ----------------------------------------------------------------------

fn send(status: StatusCode, body: &Value) -> ApiResult<Option<axum::response::Response>> {
    Ok(Some(json(status, body)))
}

/// `{ error: error.message, code: error?.code }`: `code: undefined` не пишется.
fn failure(status: StatusCode, message: &str, code: Option<&str>) -> ApiError {
    let error = ApiError::new(status, message);
    match code {
        Some(code) => error.with_code(code),
        None => error,
    }
}

/// Ошибка чтения тела внутри `try` маршрута: 400 с её кодом (и обрыв тоже).
fn body_failure(error: BodyError) -> ApiError {
    failure(StatusCode::BAD_REQUEST, error.message, Some(error.code))
}

fn core_failure(error: crate::core::CoreError) -> ApiError {
    ApiError::internal(error.to_string())
}

fn setup_failure(error: CombatLabSetupError) -> ApiError {
    failure(StatusCode::BAD_REQUEST, &error.message, error.code.as_deref())
}

/// `/^\/api\/admin\/combat-lab\/runs\/([^/]+)(\/report)?$/u`: `(id, report)`.
fn run_path(pathname: &str) -> Option<(&str, bool)> {
    let rest = pathname.strip_prefix(RUNS)?;
    let (id, report) = match rest.split_once('/') {
        Some((id, "report")) => (id, true),
        Some(_) => return None,
        None => (rest, false),
    };
    (!id.is_empty()).then_some((id, report))
}

// --- маршрут ---------------------------------------------------------------------

fn combat_lab(ctx: &mut RouteCtx) -> PassFuture<'_> {
    Box::pin(async move {
        let pathname = ctx.pathname.clone();
        let method = ctx.method.clone();
        if pathname == "/api/admin/combat-lab/scenarios" && method == Method::GET {
            require_admin(ctx).await?;
            return send(StatusCode::OK, &json!({ "scenarios": lab(&ctx.state).scenarios() }));
        }
        if pathname == "/api/admin/combat-lab/catalog" && method == Method::GET {
            require_admin(ctx).await?;
            let lab = lab(&ctx.state);
            let catalog = blocking(move || lab.catalog()).await.map_err(core_failure)?.map_err(setup_failure)?;
            return send(StatusCode::OK, &catalog);
        }
        let assess = pathname == "/api/admin/combat-lab/encounter/assess";
        if (assess || pathname == "/api/admin/combat-lab/encounter/generate") && method == Method::POST {
            require_admin(ctx).await?;
            let body = ctx.json_body().await.map_err(body_failure)?;
            let lab = lab(&ctx.state);
            let result = blocking(move || if assess { lab.assess_encounter(Some(&body)) } else { lab.generate_encounter(Some(&body)) }).await.map_err(core_failure)?;
            return send(StatusCode::OK, &result.map_err(setup_failure)?);
        }
        if pathname == "/api/admin/combat-lab/runs" && method == Method::GET {
            require_admin(ctx).await?;
            return send(StatusCode::OK, &json!({ "activeRun": lab(&ctx.state).active() }));
        }
        if pathname == "/api/admin/combat-lab/runs" && method == Method::POST {
            require_admin(ctx).await?;
            let body = ctx.json_body().await.map_err(body_failure)?;
            let lab = lab(&ctx.state);
            let created = blocking(move || lab.create(body.get("scenario"), body.get("seed"), body.get("config"))).await.map_err(core_failure)?;
            return match created {
                Ok(run) => send(StatusCode::ACCEPTED, &json!({ "id": run.get("id") })),
                Err(error) => {
                    // `error instanceof CombatLabError ? error.status : 400`.
                    let status = match &error {
                        CreateError::Lab(error) => StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST),
                        CreateError::Setup(_) => StatusCode::BAD_REQUEST,
                    };
                    Err(failure(status, error.message(), error.code()))
                }
            };
        }
        let Some((raw_id, report)) = run_path(&pathname) else { return Ok(None) };
        if method != Method::GET && method != Method::DELETE {
            return Ok(None);
        }
        require_admin(ctx).await?;
        // `decodeURIComponent` вне `try`: битый код — исключение мимо маршрута (500).
        let id = crate::url::decode_uri_component(raw_id).ok_or_else(|| ApiError::internal("URIError: URI malformed"))?;
        let lab = lab(&ctx.state);
        if report {
            if method != Method::GET {
                return Err(ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "Отчёт доступен только для чтения"));
            }
            let Some(report) = lab.report(&id) else { return Err(ApiError::new(StatusCode::NOT_FOUND, RUN_NOT_FOUND)) };
            let mut response = json(StatusCode::OK, &report);
            response.headers_mut().insert("content-disposition", HeaderValue::from_static("attachment; filename=\"combat-lab-report.json\""));
            return Ok(Some(response));
        }
        if method == Method::GET {
            // `rawAfter == null ? -1 : Number(rawAfter)`.
            let after = ctx.search_param("after").map_or(-1.0, |raw| js::parse_number(&raw));
            if !(after.is_finite() && after.fract() == 0.0) || !(-1.0..=2000.0).contains(&after) {
                return Err(ApiError::new(StatusCode::BAD_REQUEST, "Некорректный номер последнего кадра"));
            }
            return match lab.get(&id, after) {
                Some(run) => send(StatusCode::OK, &run),
                None => Err(ApiError::coded(StatusCode::NOT_FOUND, RUN_NOT_FOUND, "COMBAT_LAB_RUN_NOT_FOUND")),
            };
        }
        match blocking(move || lab.cancel(&id)).await.map_err(core_failure)? {
            Some(run) => send(StatusCode::ACCEPTED, &run),
            None => Err(ApiError::coded(StatusCode::NOT_FOUND, RUN_NOT_FOUND, "COMBAT_LAB_RUN_NOT_FOUND")),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_path_follows_js_regex() {
        assert_eq!(run_path("/api/admin/combat-lab/runs/r1"), Some(("r1", false)));
        assert_eq!(run_path("/api/admin/combat-lab/runs/r1/report"), Some(("r1", true)));
        assert_eq!(run_path("/api/admin/combat-lab/runs/report"), Some(("report", false)));
        assert_eq!(run_path("/api/admin/combat-lab/runs/r1/reports"), None);
        assert_eq!(run_path("/api/admin/combat-lab/runs/r1/report/x"), None);
        assert_eq!(run_path("/api/admin/combat-lab/runs/"), None);
        assert_eq!(run_path("/api/admin/combat-lab/runs//report"), None);
    }
}

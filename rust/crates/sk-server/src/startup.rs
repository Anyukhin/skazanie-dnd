//! Запуск и резервы бросков — перенос `server/index.mjs:3537–3622, 6482–6505`:
//! сверка всех комнат и снятие осиротевших резервов бросков до `listen`,
//! включение домашних правил «по умолчанию» через 250 мс после старта, снятие
//! резерва броска упавшего запроса (`finishFailedRollReservation`).
//!
//! Толчки координатора боя и часов мира (6498–6499) — С17
//! ([`crate::clocks::startup_nudges`] из [`startup_jobs`]).

use std::rc::Rc;

use serde_json::{json, Value};
use sk_core::js;
use sk_store::executor::{AuthoritativeExecutor, DerivedRequest, Producer};
use sk_store::LoadOptions;

use crate::core::GameCore;
use crate::error::Failure;
use crate::projection::{executor_failure, persist_authoritative_projection, reconcile_all_campaign_projections, HookedJournal, PersistOptions};

/// Резерв броска, взятый `consume` до commit (`rollReservation` в маршрутах).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RollReservation {
    pub roll_id: String,
    pub campaign_id: String,
    pub idempotency_key: String,
}

/// До `listen` (6482–6483): сверка комнат, затем резервы бросков.
/// Ответ — отказы сверки по кампаниям.
pub fn prepare(core: &Rc<GameCore>) -> Result<Vec<(String, Failure)>, Failure> {
    let failures = reconcile_all_campaign_projections(core)?;
    release_orphan_roll_reservations(core);
    Ok(failures)
}

/// Через 250 мс после `listen` (6494–6504): толчки координатора боя и часов
/// мира (С17, [`crate::clocks::startup_nudges`]), затем домашние правила
/// «по умолчанию» для каждой комнаты.
pub fn startup_jobs(core: &Rc<GameCore>) {
    let codes = match crate::room::list_room_codes(core) {
        Ok(codes) => codes,
        Err(error) => {
            eprintln!("[Сказание] Не удалось прочитать комнаты для фоновых задач: {error}");
            return;
        }
    };
    crate::clocks::startup_nudges(core, &codes);
    for campaign_id in codes {
        enable_default_house_rules(core, &campaign_id);
    }
}

/// `enableDefaultHouseRules(campaignId)` (3544–3573): правила «по умолчанию»
/// для уже идущих кампаний. Ключ идемпотентности постоянный — повторный старт
/// ничего не дублирует; явный выбор ведущего и идущий бой кампанию не
/// трогают (`defaultHouseRuleEvent`).
pub fn enable_default_house_rules(core: &Rc<GameCore>, campaign_id: &str) {
    for house_rule_id in sk_ruleset::ruleset_config::DEFAULT_ON_HOUSE_RULE_IDS {
        if let Err(error) = enable_default_house_rule(core, campaign_id, house_rule_id) {
            if error.code.as_deref() == Some("CAMPAIGN_NOT_FOUND") {
                continue;
            }
            eprintln!("[Сказание] Не удалось включить правило {house_rule_id} в {campaign_id}: {error}");
        }
    }
}

fn enable_default_house_rule(core: &Rc<GameCore>, campaign_id: &str, house_rule_id: &str) -> Result<(), Failure> {
    let key = format!("house-rule-default:{house_rule_id}");
    let derive = |fresh: &Value, _loaded: &sk_store::Loaded| -> Result<Vec<Value>, sk_core::RuleError> {
        let history = Value::Array(core.events.get_events(campaign_id, 0, None).map_err(|error| sk_core::RuleError::new(error.code, error.message))?);
        let event = sk_ruleset::campaign_ruleset::default_house_rule_event(house_rule_id, Some(fresh), Some(&history), None).map_err(|error| sk_core::RuleError::new(error.code.clone(), error.message.clone()))?;
        Ok(event.into_iter().collect())
    };
    // Метаданные события правила собраны им же: ошибка разбора здесь — пустые
    // метаданные (в JS — `TypeError` того же невозможного события).
    let metadata = |events: &[Value], _state: &Value, _loaded: &sk_store::Loaded| -> Value { sk_ruleset::campaign_ruleset::campaign_house_rule_metadata(events.first()).unwrap_or_else(|_| json!({})) };
    let journal = HookedJournal(&core.events);
    let executor = AuthoritativeExecutor::new(&journal);
    let request = DerivedRequest {
        campaign_id,
        idempotency_key: &key,
        events: None,
        derive_events: Some(&derive),
        producer: Some(Producer::CampaignRuleset),
        derived_from: Vec::new(),
        metadata: Value::Null,
        derive_metadata: Some(&metadata),
    };
    let Some(committed) = executor.commit_derived(request).map_err(executor_failure)? else { return Ok(()) };
    if committed.replayed {
        return Ok(());
    }
    let latest = core.events.load(campaign_id, &LoadOptions::default())?;
    persist_authoritative_projection(core, campaign_id, &latest.state, &committed.commit.events, None, PersistOptions::default())?;
    let settings = sk_ruleset::campaign_ruleset::campaign_house_rule_settings(Some(&latest.state));
    let rule = settings.as_array().and_then(|rules| rules.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some(house_rule_id)));
    let label = rule.and_then(|rule| rule.get("label")).filter(|value| js::present(Some(value))).map_or_else(|| house_rule_id.to_string(), |value| js::s(Some(value)));
    let description = js::s(rule.and_then(|rule| rule.get("description")));
    crate::journal::append_room_journal(
        core,
        campaign_id,
        &[json!({
            "id": format!("house-rule-default-{campaign_id}-{house_rule_id}"),
            "speaker": "system",
            "author": "Настройки кампании",
            "text": format!("Домашнее правило «{label}» включено. {description}. Выключить можно в «Опциях»."),
        })],
    )?;
    println!("[Сказание] {campaign_id}: включено правило {house_rule_id}");
    Ok(())
}

/// `finishFailedRollReservation(reservation, error)` (3596–3610): резерв
/// упавшего запроса снимается, если commit по его ключу так и не появился.
/// Исход читается из журнала; не прочитался — бросок остаётся потреблённым.
/// `ROLL_CONTEXT_MISMATCH` (кость к чужой заявке) сжигает кость.
pub fn finish_failed_roll_reservation(core: &GameCore, reservation: Option<&RollReservation>, error_code: Option<&str>) {
    let Some(reservation) = reservation else { return };
    let mut committed = true;
    if error_code != Some("ROLL_CONTEXT_MISMATCH") {
        if let Ok(found) = core.events.get_by_idempotency_key(&reservation.campaign_id, &reservation.idempotency_key) {
            committed = found.is_some();
        }
    }
    let options = json!({ "idempotencyKey": reservation.idempotency_key, "committed": committed });
    if let Err(error) = core.rolls.borrow_mut().finish_reservation(&Value::String(reservation.roll_id.clone()), &options) {
        eprintln!("[Сказание] Резерв броска не снят: {}", error.code().map_or_else(|| error.to_string(), str::to_string));
    }
}

/// `releaseOrphanRollReservations()` (3612–3621): на старте держателей нет —
/// резервы без commit снимаются. Ответ — снятые броски.
pub fn release_orphan_roll_reservations(core: &GameCore) -> Vec<String> {
    let events = &core.events;
    let released = core.rolls.borrow_mut().release_orphan_reservations(|campaign_id, idempotency_key| events.get_by_idempotency_key(campaign_id, idempotency_key).map(|found| found.is_some()));
    match released {
        Ok(released) => {
            if !released.is_empty() {
                eprintln!("[Сказание] Сняты резервы бросков без commit: {}", released.len());
            }
            released
        }
        Err(error) => {
            eprintln!("[Сказание] Не удалось проверить резервы бросков: {error}");
            Vec::new()
        }
    }
}

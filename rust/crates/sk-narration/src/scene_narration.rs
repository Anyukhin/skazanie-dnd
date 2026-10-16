//! Перенос `server/scene-narration.mjs`: рассказчик смены сцены без модели.
//!
//! Текст собирается только из уже закоммиченных фактов: `transition` и
//! `arrival` события `SceneAdvanced`, время в пути по `TimeAdvanced`, время
//! суток на месте и строка торговли (`sk_economy::merchant_narration`).
//!
//! Рассказчик регистрируется первым (приоритет `scene`): смена сцены
//! перекрывает и торговлю, и появление противников. В JS — при импорте модуля,
//! здесь — [`register_scene_narrator`].

use std::sync::{Arc, LazyLock, OnceLock};

use serde_json::Value;
use sk_core::{js, re, text};
use sk_economy::merchant_narration::merchant_narration;
use sk_narration_base::deterministic_narration::{register_deterministic_narrator, DeterministicNarrator, NarratorContractError, SharedNarrator, NARRATOR_PRIORITY};
use sk_world_time::weather::{clock_minute_of, elapsed_minutes_of};

use crate::jsv::{clean_text, get, num_or0, path};

fn is_scene_advanced(event: &Value) -> bool {
    get(Some(event), "event_type").and_then(Value::as_str) == Some("SceneAdvanced")
}

/// `hasSceneEvent(events)`.
pub fn has_scene_event(events: &[Value]) -> bool {
    events.iter().any(is_scene_advanced)
}

/// `sceneNarration(events, state)`: текст последнего `SceneAdvanced` или
/// `None`, если перехода в событиях нет.
pub fn scene_narration(events: &[Value], state: &Value) -> Option<String> {
    let event = events.iter().rev().find(|candidate| is_scene_advanced(candidate))?;
    let transition = sentence(clean_text(path(Some(event), &["payload", "transition"]), 1_000));
    let arrival = sentence(clean_text(path(Some(event), &["payload", "arrival"]), 1_000));
    let commerce = merchant_narration(events, state).unwrap_or_default();
    let arrival_line = [arrival, travel_time_sentence(events, state)].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    Some([transition, arrival_line, commerce].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n\n"))
}

const HOURS_GENITIVE: [&str; 13] = ["", "часа", "двух", "трёх", "четырёх", "пяти", "шести", "семи", "восьми", "девяти", "десяти", "одиннадцати", "двенадцати"];

/// «около двух с половиной часов», «около полутора часов», «около получаса».
fn travel_duration_ru(minutes: f64) -> String {
    if minutes < 45.0 {
        return "около получаса".into();
    }
    let halves = js::round(minutes / 30.0).max(2.0);
    let hours = (halves / 2.0).floor();
    let half = halves % 2.0 == 1.0;
    if hours == 1.0 {
        return if half { "около полутора часов" } else { "около часа" }.into();
    }
    if hours >= HOURS_GENITIVE.len() as f64 {
        return "полдня".into();
    }
    // `hours` здесь — целое 2…12: `halves` не меньше 2, `hours` меньше 13.
    let word = HOURS_GENITIVE[hours as usize];
    format!("около {word}{} часов", if half { " с половиной" } else { "" })
}

/// Время суток к приходу словами стола.
fn arrival_day_part_ru(elapsed_minutes: i64) -> &'static str {
    let hour = clock_minute_of(elapsed_minutes) / 60;
    match hour {
        _ if hour < 4 => "стоит глубокая ночь",
        _ if hour < 6 => "до рассвета уже недалеко",
        _ if hour < 10 => "наступило утро",
        _ if hour < 17 => "день в разгаре",
        _ if hour < 21 => "вечереет",
        _ => "ночь только начинается",
    }
}

/// Сколько шёл отряд и который час на месте. Короткий путь — меньше получаса —
/// не называется.
fn travel_time_sentence(events: &[Value], state: &Value) -> String {
    let travel = events
        .iter()
        .filter(|candidate| get(Some(candidate), "event_type").and_then(Value::as_str) == Some("TimeAdvanced"))
        .fold(0.0, |sum, candidate| {
            let minutes = num_or0(path(Some(candidate), &["payload", "elapsed_minutes"]));
            sum + if minutes > 0.0 { minutes } else { 0.0 }
        });
    if travel < 30.0 {
        return String::new();
    }
    format!("Дорога заняла {}; {}.", travel_duration_ru(travel), arrival_day_part_ru(elapsed_minutes_of(state)))
}

/// Архитектор пишет `transition` и `arrival` фразами без точки; хроника
/// показывает абзацы подряд, и без точки они сливались.
fn sentence(value: String) -> String {
    if value.is_empty() {
        return value;
    }
    let core = text::replace_first(re!(r#"[»"”')\]]+$"#, "u"), &value, "");
    if text::test(re!(r"[.!?…]$", "u"), &core) {
        value
    } else {
        format!("{value}.")
    }
}

/// `sceneNarrator`: рассказчик смены сцены.
#[derive(Debug, Default, Clone, Copy)]
pub struct SceneNarrator;

impl DeterministicNarrator for SceneNarrator {
    fn id(&self) -> &str {
        "scene"
    }

    fn prompt_version(&self) -> &str {
        "scene-narrator/v1"
    }

    fn provider(&self) -> &str {
        "deterministic-scene"
    }

    fn priority(&self) -> f64 {
        NARRATOR_PRIORITY.scene
    }

    fn matches(&self, events: &[Value]) -> bool {
        has_scene_event(events)
    }

    fn narrate(&self, events: &[Value], state: &Value) -> Option<String> {
        scene_narration(events, state)
    }
}

/// Рассказчик смены сцены как общий объект реестра.
pub static SCENE_NARRATOR: LazyLock<SharedNarrator> = LazyLock::new(|| Arc::new(SceneNarrator));

/// Зарегистрировать рассказчика в общем реестре сервера (в JS — при импорте
/// модуля). Повторный вызов возвращает итог первой регистрации.
pub fn register_scene_narrator() -> Result<SharedNarrator, NarratorContractError> {
    static REGISTERED: OnceLock<Result<SharedNarrator, NarratorContractError>> = OnceLock::new();
    REGISTERED.get_or_init(|| register_deterministic_narrator(Arc::clone(&SCENE_NARRATOR))).clone()
}

//! Перенос `server/deterministic-narration.mjs`: общий контракт рассказчиков
//! без модели и их реестр.
//!
//! Рассказчик узнаёт свои события и превращает их в текст из уже
//! закоммиченных событий — модель здесь не вызывается. Порядок в реестре и есть
//! приоритет: он задан **числом в самом рассказчике** (меньше — раньше, при
//! равенстве — по `id` через `localeCompare`), а не порядком регистрации.
//!
//! В JS рассказчик — объект с полями `id`, `promptVersion`, `provider`,
//! `priority` и методами `matches`, `narrate`; модули регистрируют себя при
//! импорте. В Rust это трейт [`DeterministicNarrator`]; крейт рассказчика
//! регистрирует его в глобальном реестре ([`register_deterministic_narrator`])
//! при запуске сервера или держит свой [`NarratorRegistry`]. Методы трейта
//! гарантированы типом, поэтому проверка контракта сводится к непустым строкам
//! и конечному приоритету.

use std::sync::{Arc, PoisonError, RwLock};

use serde::Serialize;
use serde_json::Value;
use sk_core::{re, text};

use crate::jsx;

/// Рассказчик без модели.
pub trait DeterministicNarrator: Send + Sync {
    /// Короткое имя для меток трассы.
    fn id(&self) -> &str;
    /// Что писать в `prompt_version`.
    fn prompt_version(&self) -> &str;
    /// Что писать в `provider`.
    fn provider(&self) -> &str;
    /// Меньше — раньше.
    fn priority(&self) -> f64;
    /// Его ли это события.
    fn matches(&self, events: &[Value]) -> bool;
    /// Текст по событиям или `None`, если собрать нечего.
    fn narrate(&self, events: &[Value], state: &Value) -> Option<String>;
}

/// Рассказчик в реестре.
pub type SharedNarrator = Arc<dyn DeterministicNarrator>;

/// Нарушение контракта (`TypeError` в JS); текст — как в JS.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct NarratorContractError(pub String);

/// `NARRATOR_PRIORITY`: смена сцены перекрывает торговлю, торговля — появление
/// противников; боевой текст — последним.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct NarratorPriority {
    #[serde(serialize_with = "jsx::serialize_js_number")]
    pub scene: f64,
    #[serde(serialize_with = "jsx::serialize_js_number")]
    pub merchant: f64,
    #[serde(serialize_with = "jsx::serialize_js_number")]
    pub encounter: f64,
    #[serde(serialize_with = "jsx::serialize_js_number")]
    pub combat: f64,
}

pub const NARRATOR_PRIORITY: NarratorPriority = NarratorPriority { scene: 10.0, merchant: 20.0, encounter: 30.0, combat: 40.0 };

/// Предел `cleanNarrationText` по умолчанию.
pub const CLEAN_NARRATION_DEFAULT_MAXIMUM: usize = 1_000;
/// Предел `narrationTextOr` по умолчанию.
pub const NARRATION_TEXT_OR_DEFAULT_MAXIMUM: usize = 120;

/// `cleanNarrationText(value, maximum)`: пробелы схлопнуты, края обрезаны,
/// не длиннее `maximum` символов. Единственная нормализация на все рассказчики.
pub fn clean_narration_text(value: Option<&Value>, maximum: usize) -> String {
    let collapsed = text::replace_all(re!(r"\s+", "gu"), &jsx::string(value), " ");
    text::head(text::trim(&collapsed), maximum)
}

/// То же для строки.
pub fn clean_narration_str(value: &str, maximum: usize) -> String {
    let collapsed = text::replace_all(re!(r"\s+", "gu"), value, " ");
    text::head(text::trim(&collapsed), maximum)
}

/// `narrationTextOr(value, fallback, maximum)`: пустая строка до игрока не доезжает.
pub fn narration_text_or(value: Option<&Value>, fallback: &str, maximum: usize) -> String {
    let cleaned = clean_narration_text(value, maximum);
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

/// `assertNarratorContract(narrator)`.
pub fn assert_narrator_contract(narrator: &dyn DeterministicNarrator) -> Result<(), NarratorContractError> {
    let label = if narrator.id().is_empty() { "рассказчик без id".to_string() } else { format!("рассказчик {}", narrator.id()) };
    for (field, value) in [("id", narrator.id()), ("promptVersion", narrator.prompt_version()), ("provider", narrator.provider())] {
        if value.is_empty() {
            return Err(NarratorContractError(format!("{label}: поле {field} обязательно")));
        }
    }
    if !narrator.priority().is_finite() {
        return Err(NarratorContractError(format!("{label}: приоритет обязан быть числом")));
    }
    Ok(())
}

/// Реестр рассказчиков, упорядоченный по приоритету.
#[derive(Default)]
pub struct NarratorRegistry {
    narrators: Vec<SharedNarrator>,
}

impl NarratorRegistry {
    pub const fn new() -> Self {
        Self { narrators: Vec::new() }
    }

    /// `registerDeterministicNarrator`: проверка контракта, отказ на повторный
    /// `id`, затем устойчивая сортировка по приоритету и `id`.
    pub fn register(&mut self, narrator: SharedNarrator) -> Result<SharedNarrator, NarratorContractError> {
        assert_narrator_contract(narrator.as_ref())?;
        if self.narrators.iter().any(|known| known.id() == narrator.id()) {
            return Err(NarratorContractError(format!("Рассказчик {} уже зарегистрирован", narrator.id())));
        }
        self.narrators.push(Arc::clone(&narrator));
        self.narrators.sort_by(|left, right| {
            let difference = left.priority() - right.priority();
            if difference != 0.0 && !difference.is_nan() {
                return difference.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
            }
            text::locale_compare(left.id(), right.id())
        });
        Ok(narrator)
    }

    /// `deterministicNarrators()`: копия списка.
    pub fn narrators(&self) -> Vec<SharedNarrator> {
        self.narrators.clone()
    }

    /// `deterministicNarratorFor(events)`: первый, узнавший свои события.
    pub fn narrator_for(&self, events: &[Value]) -> Option<SharedNarrator> {
        self.narrators.iter().find(|narrator| narrator.matches(events)).cloned()
    }
}

static REGISTRY: RwLock<NarratorRegistry> = RwLock::new(NarratorRegistry::new());

/// Зарегистрировать рассказчика в общем реестре сервера.
pub fn register_deterministic_narrator(narrator: SharedNarrator) -> Result<SharedNarrator, NarratorContractError> {
    REGISTRY.write().unwrap_or_else(PoisonError::into_inner).register(narrator)
}

/// Рассказчики общего реестра в порядке приоритета.
pub fn deterministic_narrators() -> Vec<SharedNarrator> {
    REGISTRY.read().unwrap_or_else(PoisonError::into_inner).narrators()
}

/// Первый рассказчик общего реестра, узнавший свои события, либо `None`.
pub fn deterministic_narrator_for(events: &[Value]) -> Option<SharedNarrator> {
    REGISTRY.read().unwrap_or_else(PoisonError::into_inner).narrator_for(events)
}

/// Ответ в том виде, в каком его ждёт оркестратор.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RenderedNarration {
    pub narration: String,
    pub prompt_version: String,
    pub provider: String,
}

/// `renderDeterministicNarration(narrator, { events, state, fallbackNarration })`:
/// запасной текст подставляется, когда рассказчик узнал события, но текста не
/// собрал (`null`); пустая строка рассказчика остаётся пустой, как `??` в JS.
pub fn render_deterministic_narration(narrator: &dyn DeterministicNarrator, events: &[Value], state: &Value, fallback_narration: &str) -> RenderedNarration {
    RenderedNarration {
        narration: narrator.narrate(events, state).unwrap_or_else(|| fallback_narration.to_string()),
        prompt_version: narrator.prompt_version().to_string(),
        provider: narrator.provider().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Stub {
        id: &'static str,
        prompt_version: &'static str,
        provider: &'static str,
        priority: f64,
        types: &'static [&'static str],
        text: Option<&'static str>,
    }

    impl Stub {
        fn new(id: &'static str, priority: f64, types: &'static [&'static str]) -> Self {
            Self { id, prompt_version: "x/v1", provider: "x", priority, types, text: None }
        }
    }

    impl DeterministicNarrator for Stub {
        fn id(&self) -> &str {
            self.id
        }
        fn prompt_version(&self) -> &str {
            self.prompt_version
        }
        fn provider(&self) -> &str {
            self.provider
        }
        fn priority(&self) -> f64 {
            self.priority
        }
        fn matches(&self, events: &[Value]) -> bool {
            events.iter().any(|event| self.types.contains(&event.get("event_type").and_then(Value::as_str).unwrap_or("")))
        }
        fn narrate(&self, _events: &[Value], _state: &Value) -> Option<String> {
            self.text.map(str::to_string)
        }
    }

    fn event(kind: &str) -> Value {
        json!({ "event_type": kind, "payload": {} })
    }

    /// Регистрация в обратном порядке: приоритет задан числом, а не порядком.
    fn ladder() -> NarratorRegistry {
        let mut registry = NarratorRegistry::new();
        registry.register(Arc::new(Stub::new("encounter", NARRATOR_PRIORITY.encounter, &["EncounterCreated"]))).expect("встреча");
        registry.register(Arc::new(Stub::new("merchant", NARRATOR_PRIORITY.merchant, &["MerchantPurchaseCompleted"]))).expect("торговля");
        registry.register(Arc::new(Stub::new("scene", NARRATOR_PRIORITY.scene, &["SceneAdvanced"]))).expect("сцена");
        registry
    }

    #[test]
    fn priority_is_a_number_not_import_order() {
        let registry = ladder();
        let order: Vec<String> = registry.narrators().iter().map(|narrator| narrator.id().to_string()).collect();
        assert_eq!(order, ["scene", "merchant", "encounter"]);
        for narrator in registry.narrators() {
            assert_narrator_contract(narrator.as_ref()).expect("контракт");
        }
    }

    #[test]
    fn selection_repeats_the_old_priority_ladder() {
        let registry = ladder();
        let pick = |events: &[Value]| registry.narrator_for(events).map(|narrator| narrator.id().to_string());
        assert_eq!(pick(&[event("SceneAdvanced")]).as_deref(), Some("scene"));
        assert_eq!(pick(&[event("MerchantPurchaseCompleted")]).as_deref(), Some("merchant"));
        assert_eq!(pick(&[event("EncounterCreated")]).as_deref(), Some("encounter"));
        assert_eq!(pick(&[event("MerchantPurchaseCompleted"), event("SceneAdvanced")]).as_deref(), Some("scene"));
        assert_eq!(pick(&[event("AttackResolved")]), None);
        assert_eq!(pick(&[]), None);
    }

    #[test]
    fn equal_priority_falls_back_to_locale_compare() {
        let mut registry = NarratorRegistry::new();
        for id in ["b", "B", "a", "ё", "е"] {
            registry.register(Arc::new(Stub::new(id, 5.0, &[]))).expect("рассказчик");
        }
        let order: Vec<String> = registry.narrators().iter().map(|narrator| narrator.id().to_string()).collect();
        assert_eq!(order, ["a", "b", "B", "е", "ё"]);
    }

    #[test]
    fn contract_rejects_incomplete_narrator() {
        let valid = Stub::new("x", 1.0, &[]);
        assert_narrator_contract(&valid).expect("полный рассказчик");
        let error = assert_narrator_contract(&Stub { id: "", ..Stub::new("x", 1.0, &[]) }).expect_err("пустой id");
        assert_eq!(error.0, "рассказчик без id: поле id обязательно");
        let error = assert_narrator_contract(&Stub { prompt_version: "", ..Stub::new("x", 1.0, &[]) }).expect_err("без версии");
        assert_eq!(error.0, "рассказчик x: поле promptVersion обязательно");
        let error = assert_narrator_contract(&Stub { provider: "", ..Stub::new("x", 1.0, &[]) }).expect_err("без провайдера");
        assert_eq!(error.0, "рассказчик x: поле provider обязательно");
        let error = assert_narrator_contract(&Stub::new("x", f64::NAN, &[])).expect_err("приоритет NaN");
        assert_eq!(error.0, "рассказчик x: приоритет обязан быть числом");
        assert!(assert_narrator_contract(&Stub::new("x", f64::INFINITY, &[])).is_err());

        let mut registry = ladder();
        let error = registry.register(Arc::new(Stub::new("scene", 1.0, &[]))).err().expect("повторный id");
        assert_eq!(error.0, "Рассказчик scene уже зарегистрирован");
        assert_eq!(registry.narrators().len(), 3);
    }

    #[test]
    fn render_substitutes_fallback_without_suggestions() {
        let narrator = Stub { prompt_version: "y/v1", provider: "y", ..Stub::new("y", 1.0, &[]) };
        let rendered = render_deterministic_narration(&narrator, &[], &json!({}), "запас");
        assert_eq!(rendered.narration, "запас");
        assert_eq!(rendered.prompt_version, "y/v1");
        assert_eq!(rendered.provider, "y");
        assert_eq!(serde_json::to_value(&rendered).expect("json"), json!({ "narration": "запас", "prompt_version": "y/v1", "provider": "y" }));
        let empty = Stub { text: Some(""), ..Stub::new("z", 1.0, &[]) };
        assert_eq!(render_deterministic_narration(&empty, &[], &json!({}), "запас").narration, "", "?? не заменяет пустую строку");
    }

    #[test]
    fn global_registry_registers_once() {
        let narrator: SharedNarrator = Arc::new(Stub::new("global-test-narrator", 99.0, &["GlobalTestEvent"]));
        register_deterministic_narrator(Arc::clone(&narrator)).expect("регистрация");
        assert!(register_deterministic_narrator(narrator).is_err(), "повторный id обязан отвергаться");
        assert!(deterministic_narrators().iter().any(|known| known.id() == "global-test-narrator"));
        assert_eq!(deterministic_narrator_for(&[event("GlobalTestEvent")]).map(|found| found.id().to_string()).as_deref(), Some("global-test-narrator"));
    }

    #[test]
    fn clean_text_collapses_spaces_and_cuts() {
        assert_eq!(clean_narration_text(Some(&json!("  Дверь \n\t скрипит  ")), 1_000), "Дверь скрипит");
        assert_eq!(clean_narration_text(Some(&json!("абвгд")), 3), "абв");
        assert_eq!(clean_narration_text(None, 10), "");
        assert_eq!(clean_narration_text(Some(&json!(12.5)), 10), "12.5");
        assert_eq!(narration_text_or(Some(&json!("   ")), "предмет", 120), "предмет");
        assert_eq!(narration_text_or(Some(&json!(" Сундук ")), "предмет", 120), "Сундук");
        assert_eq!(clean_narration_str(" a  b ", 1_000), "a b");
    }
}

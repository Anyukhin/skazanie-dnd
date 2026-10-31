//! Контекст разбора команды — объект `context` движка JS. Задача Р0.
//!
//! В JS это простой объект: поля из маршрута (`isAdmin`, `isDirector`,
//! `allowedActorIds`, `isNpcScheduler`, `serverAuthoritativeCombat`…), поля
//! продолжений (`readiedRelease`, `additionalBeam`, `resistanceChoices`…) и
//! внутренние маркеры на `Symbol` (удар монаха бонусным действием, кара,
//! вторая рука, вид действия перезарядки). Маркеры на `Symbol` переживают
//! `{ ...context }`, но не JSON — клиент прислать их не может. Здесь JSON-поля
//! лежат объектом той же формы (их читают и перенесённые валидаторы модулей),
//! а маркеры — типизированными полями, которых в JSON нет.

use serde_json::{Map, Value};
use sk_core::js;

/// `context` разбора.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Context {
    /// JSON-поля контекста в форме JS.
    pub fields: Map<String, Value>,
    /// `context[MONK_BONUS_ATTACK_CONTEXT] === MONK_BONUS_ATTACK_TOKEN`: атака
    /// уже оплачена бонусным действием монаха.
    pub monk_bonus_attack: bool,
    /// `context[DIVINE_SMITE_CONTEXT]`: `{ slot_level }` кары во вложенной атаке.
    pub divine_smite: Option<Value>,
    /// `context[OFFHAND_ATTACK_CONTEXT] === true`: удар второй рукой.
    pub offhand_attack: bool,
    /// `context[LOADING_ACTION_TYPE_CONTEXT]`: каким ресурсом оплачен выстрел
    /// оружием с перезарядкой (`action`, `bonus_action`, `reaction`).
    pub loading_action_type: Option<Value>,
}

impl Context {
    /// Контекст из JSON-объекта (не объект — пустой контекст, как `context = {}`).
    pub fn from_json(value: &Value) -> Self {
        Self { fields: value.as_object().cloned().unwrap_or_default(), ..Self::default() }
    }

    /// JSON-поля контекста (для валидаторов модулей, которые принимают `context`).
    pub fn json(&self) -> Value {
        Value::Object(self.fields.clone())
    }

    /// `context[key]` (отсутствие — `None`).
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.fields.get(key)
    }

    /// `context[key] === true`.
    pub fn is_true(&self, key: &str) -> bool {
        js::is_true(self.get(key))
    }

    /// `Boolean(context[key])`.
    pub fn truthy(&self, key: &str) -> bool {
        js::truthy(self.get(key))
    }

    /// `{ ...context, [key]: value }`.
    pub fn with(&self, key: &str, value: Value) -> Self {
        let mut next = self.clone();
        next.fields.insert(key.into(), value);
        next
    }

    /// Поле в месте (`context.key = value`).
    pub fn set(&mut self, key: &str, value: Value) {
        self.fields.insert(key.into(), value);
    }

    /// `safeInteger(context.__resolve_depth, 0)`.
    pub fn resolve_depth(&self) -> i64 {
        js::safe_int(self.get("__resolve_depth"), 0)
    }

    /// `context.isAdmin === true`.
    pub fn is_admin(&self) -> bool {
        self.is_true("isAdmin")
    }

    /// `context.isDirector === true`.
    pub fn is_director(&self) -> bool {
        self.is_true("isDirector")
    }

    /// `context.isNpcScheduler === true`.
    pub fn is_npc_scheduler(&self) -> bool {
        self.is_true("isNpcScheduler")
    }

    /// `context.serverAuthoritativeCombat === true`.
    pub fn server_authoritative_combat(&self) -> bool {
        self.is_true("serverAuthoritativeCombat")
    }
}

/// Источник UUID (`randomUUID` JS): `command_id`, `effect_id` концентрации,
/// перепродажа, выданный предмет. Боевой — [`random_uuid`], в тестах — счётчик.
pub type Uuid<'a> = &'a mut dyn FnMut() -> String;

/// `randomUUID()`.
pub fn random_uuid() -> String {
    sk_core::hash::uuid_v4()
}

/// Предсказуемые UUID для тестов: `<prefix>-1`, `<prefix>-2`…
pub fn sequence_uuids(prefix: &str) -> impl FnMut() -> String {
    let prefix = prefix.to_string();
    let mut counter = 0u64;
    move || {
        counter += 1;
        format!("{prefix}-{counter}")
    }
}

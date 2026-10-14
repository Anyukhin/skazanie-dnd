//! Реестр механических бросков — перенос `server/roll-registry.mjs`.
//!
//! Держит инвариант «один бросок не применяется дважды»: кость выдаётся
//! только под объявленную карточку проверки (`check_id`), одна на карточку;
//! её `roll_id` потребляется одним ключом идемпотентности; потребление — это
//! резерв до исхода commit (`finish_reservation`), а после перезапуска
//! осиротевшие резервы сверяются с журналом (`release_orphan_reservations`).
//! Записи живут `ttl_ms` и хранятся в durable-файле того же JSON, что пишет
//! JS (`{ schema_version: 1, rolls: [[id, entry]…], checks: [[id, entry]…] }`),
//! поэтому прежний файл читается без перевода.
//!
//! Записи держатся как `serde_json::Value` той же формы, что в JS: в файле
//! могут лежать поля прежних версий, и они переживают перезапись.

use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use sk_core::{js, RuleError};
use sk_dice::{D20Request, Dice, DiceError, Visibility};

use crate::support::{field, nullish, number, resolve, string_or_blank, string_or_empty, strict_number, strict_str, stringify, template};

/// Срок жизни карточки и кости по умолчанию: десять минут.
pub const DEFAULT_ROLL_TTL_MS: i64 = 10 * 60 * 1000;

/// Отказ реестра.
#[derive(Debug, thiserror::Error)]
pub enum RollRegistryError {
    /// `RollRegistryError` JS: код и текст для клиента.
    #[error("{message}")]
    Rejected { code: &'static str, message: String },
    /// `TypeError` JS: испорченная запись durable-файла, которую JS не пережил бы.
    #[error("{0}")]
    Type(String),
    /// `DiceExpressionError` из `rollCheck`: карточка с недопустимым модификатором или СЛ.
    #[error(transparent)]
    Dice(#[from] DiceError),
    /// Отказ `validateContext` вызывающего: его код и текст.
    #[error("{}", .0.message)]
    Validation(RuleError),
    /// Сбой записи durable-файла (в JS — ошибка `node:fs`).
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl RollRegistryError {
    /// `error.code`, как его видит маршрут; у ошибок без кода в JS — `None`.
    pub fn code(&self) -> Option<&str> {
        match self {
            RollRegistryError::Rejected { code, .. } => Some(code),
            RollRegistryError::Validation(error) => Some(&error.code),
            _ => None,
        }
    }

    /// `error.name`.
    pub fn name(&self) -> &'static str {
        match self {
            RollRegistryError::Rejected { .. } => "RollRegistryError",
            RollRegistryError::Type(_) => "TypeError",
            RollRegistryError::Dice(_) => "DiceExpressionError",
            RollRegistryError::Validation(_) | RollRegistryError::Io(_) => "Error",
        }
    }
}

fn rejected(code: &'static str, message: &str) -> RollRegistryError {
    RollRegistryError::Rejected { code, message: message.into() }
}

/// Настройки реестра (`new RollRegistry({ ttlMs, now, checkIdFactory, storageFile })`).
pub struct RollRegistryOptions {
    pub ttl_ms: i64,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub check_id_factory: Box<dyn FnMut() -> String + Send>,
    pub storage_file: Option<PathBuf>,
}

impl Default for RollRegistryOptions {
    fn default() -> Self {
        Self {
            ttl_ms: DEFAULT_ROLL_TTL_MS,
            now: Arc::new(sk_core::clock::now_ms),
            check_id_factory: Box::new(sk_core::hash::uuid_v4),
            storage_file: None,
        }
    }
}

/// `RollRegistry`.
///
/// Методы берут `&mut self`: в JS реестр живёт в одном потоке событий, здесь
/// его держат под одним замком.
pub struct RollRegistry {
    dice: Box<dyn Dice + Send>,
    ttl_ms: i64,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    check_id_factory: Box<dyn FnMut() -> String + Send>,
    storage_file: Option<PathBuf>,
    rolls: IndexMap<String, Value>,
    checks: IndexMap<String, Value>,
    /// Аудит PR #131, SEC-04: сколько запросов этого процесса держат резерв
    /// броска (потребили его и ещё не узнали исход commit). Только в памяти:
    /// после перезапуска держателей нет по определению.
    reservation_holders: HashMap<String, i64>,
}

impl RollRegistry {
    pub fn new(dice: Box<dyn Dice + Send>, options: RollRegistryOptions) -> Result<Self, RollRegistryError> {
        let mut registry = Self {
            dice,
            ttl_ms: options.ttl_ms,
            now: options.now,
            check_id_factory: options.check_id_factory,
            storage_file: options.storage_file.map(|file| resolve(&file)),
            rolls: IndexMap::new(),
            checks: IndexMap::new(),
            reservation_holders: HashMap::new(),
        };
        registry.load()?;
        registry.cleanup()?;
        Ok(registry)
    }

    /// Выданные кости (`registry.rolls`).
    pub fn rolls(&self) -> &IndexMap<String, Value> {
        &self.rolls
    }

    /// Карточки проверок (`registry.checks`).
    pub fn checks(&self) -> &IndexMap<String, Value> {
        &self.checks
    }

    fn now(&self) -> i64 {
        (self.now)()
    }

    fn load(&mut self) -> Result<(), RollRegistryError> {
        let Some(file) = &self.storage_file else { return Ok(()) };
        if !file.exists() {
            return Ok(());
        }
        let payload: Value = match fs::read(file) {
            Ok(bytes) => serde_json::from_str(&String::from_utf8_lossy(&bytes))
                .map_err(|error| rejected("ROLL_REGISTRY_CORRUPT", &format!("Повреждено durable-хранилище бросков: {error}")))?,
            Err(error) => return Err(rejected("ROLL_REGISTRY_CORRUPT", &format!("Повреждено durable-хранилище бросков: {error}"))),
        };
        let (Some(Value::Array(rolls)), Some(Value::Array(checks))) = (payload.get("rolls"), payload.get("checks")) else {
            return Err(rejected("ROLL_REGISTRY_CORRUPT", "Некорректная схема durable-хранилища бросков"));
        };
        if !strict_number(payload.get("schema_version"), 1.0) {
            return Err(rejected("ROLL_REGISTRY_CORRUPT", "Некорректная схема durable-хранилища бросков"));
        }
        self.rolls = pairs(rolls)?;
        self.checks = pairs(checks)?;
        Ok(())
    }

    fn persist(&self) -> Result<(), RollRegistryError> {
        let Some(file) = &self.storage_file else { return Ok(()) };
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut temporary = file.as_os_str().to_owned();
        temporary.push(format!(".{}.{}.tmp", std::process::id(), sk_core::hash::uuid_v4()));
        let temporary = PathBuf::from(temporary);
        let body = stringify(&json!({
            "schema_version": 1,
            "rolls": entries_value(&self.rolls),
            "checks": entries_value(&self.checks),
        }));
        let mut handle = crate::support::create_exclusive(&temporary)?;
        let written = handle.write_all(body.as_bytes());
        drop(handle);
        written?;
        fs::rename(&temporary, file)?;
        Ok(())
    }

    /// `cleanup()`: убрать истёкшие кости и карточки.
    pub fn cleanup(&mut self) -> Result<(), RollRegistryError> {
        let now = self.now() as f64;
        let before = self.rolls.len() + self.checks.len();
        // `entry.expires_at <= now` по правилам JS: `NaN` не истекает.
        let alive = |entry: &Value| !(number(field(Some(entry), "expires_at")) <= now);
        self.rolls.retain(|_, entry| alive(entry));
        self.checks.retain(|_, entry| alive(entry));
        if self.rolls.len() + self.checks.len() != before {
            self.persist()?;
        }
        Ok(())
    }

    /// `registerCheck({ campaignId, actorId, label, modifier, difficulty, ability, advantage, disadvantage, visibility, context })`.
    pub fn register_check(&mut self, options: &Value) -> Result<Value, RollRegistryError> {
        self.cleanup()?;
        let option = |key: &str| field(Some(options), key);
        let check_id = (self.check_id_factory)();
        let label = match option("label") {
            None => "Проверка".to_string(),
            value => template(value),
        };
        let modifier = match option("modifier") {
            None => 0.0,
            value => js::number(value),
        };
        let difficulty = match option("difficulty") {
            None => 10.0,
            value => js::number(value),
        };
        let ability = match option("ability") {
            None | Some(Value::Null) => Value::Null,
            value => Value::String(js::s(value)),
        };
        let mut check = Map::new();
        check.insert("check_id".into(), Value::String(check_id.clone()));
        check.insert("campaign_id".into(), Value::String(string_or_empty(option("campaignId"))));
        check.insert("actor_id".into(), Value::String(string_or_empty(option("actorId"))));
        check.insert("label".into(), Value::String(sk_core::text::head(&label, 80)));
        check.insert("modifier".into(), js::num(modifier));
        check.insert("difficulty".into(), js::num(difficulty));
        check.insert("ability".into(), ability);
        check.insert("advantage".into(), Value::Bool(js::truthy(option("advantage"))));
        check.insert("disadvantage".into(), Value::Bool(js::truthy(option("disadvantage"))));
        check.insert("visibility".into(), option("visibility").cloned().unwrap_or_else(|| Value::String("public".into())));
        // Служебный контекст хода (например, судейское прочтение свободного
        // действия): не показывается игроку, а возвращается серверу при consume,
        // чтобы вторая фаза хода не выводила решение заново.
        if js::truthy(option("context")) {
            check.insert("context".into(), option("context").cloned().unwrap_or(Value::Null));
        }
        check.insert("expires_at".into(), Value::from(self.now() + self.ttl_ms));
        let mut visible = check.clone();
        self.checks.insert(check_id, Value::Object(check));
        self.persist()?;
        visible.shift_remove("context");
        Ok(Value::Object(visible))
    }

    fn assert_owner(entry: &Value, options: &Value, message: &str, code: &'static str) -> Result<(), RollRegistryError> {
        let campaign = string_or_empty(field(Some(options), "campaignId"));
        let actor = string_or_empty(field(Some(options), "actorId"));
        if !strict_str(field(Some(entry), "campaign_id"), &campaign) || !strict_str(field(Some(entry), "actor_id"), &actor) {
            return Err(rejected(code, message));
        }
        Ok(())
    }

    /// `getCheck(checkId, { campaignId, actorId, includeContext })`.
    pub fn get_check(&mut self, check_id: &Value, options: &Value) -> Result<Value, RollRegistryError> {
        self.cleanup()?;
        let check = self
            .checks
            .get(&string_or_blank(Some(check_id)))
            .filter(|check| js::truthy(Some(check)))
            .ok_or_else(|| rejected("CHECK_NOT_FOUND", "Проверка не найдена или истекла"))?;
        Self::assert_owner(check, options, "Проверка принадлежит другому ходу или персонажу", "CHECK_FORBIDDEN")?;
        if js::present(field(Some(check), "invalidated_at")) {
            return Err(rejected("CHECK_INVALIDATED", "Эта проверка отменена: заявка была изменена"));
        }
        let mut visible = check.as_object().cloned().unwrap_or_default();
        let context = visible.shift_remove("context");
        if js::truthy(field(Some(options), "includeContext")) && js::truthy(context.as_ref()) {
            visible.insert("context".into(), context.unwrap_or(Value::Null));
        }
        Ok(Value::Object(visible))
    }

    /// Выдана ли под карточку кость, которую уже потребили.
    fn issued_roll_consumed(&self, check: &Value) -> bool {
        let issued = field(Some(check), "issued_roll_id");
        if !js::truthy(issued) {
            return false;
        }
        // `Map.get` по сырому значению: числовой id из файла ключом не совпадёт.
        match issued {
            Some(Value::String(id)) => js::truthy(field(self.rolls.get(id), "consumed_by")),
            _ => false,
        }
    }

    /// Есть ли у кампании открытая проверка на этой версии состояния: заявленная,
    /// не отменённая и ещё не брошенная. Перестройка карты ждёт её завершения.
    pub fn has_open_check(&mut self, options: &Value) -> Result<bool, RollRegistryError> {
        self.cleanup()?;
        let campaign = template(field(Some(options), "campaignId"));
        let version = number(field(Some(options), "stateVersion"));
        Ok(self.checks.values().any(|check| {
            strict_str(field(Some(check), "campaign_id"), &campaign)
                && !js::present(field(Some(check), "invalidated_at"))
                && number(field(field(Some(check), "context"), "state_version")) == version
                && !self.issued_roll_consumed(check)
        }))
    }

    /// `pendingNarrationCheck({ campaignId, actorId, stateVersion })`.
    pub fn pending_narration_check(&mut self, options: &Value) -> Result<Option<Value>, RollRegistryError> {
        self.cleanup()?;
        let campaign = template(field(Some(options), "campaignId"));
        let actor = template(field(Some(options), "actorId"));
        let version = number(field(Some(options), "stateVersion"));
        let entry = self.checks.values().rev().find(|check| {
            let context = field(Some(check), "context");
            strict_str(field(Some(check), "campaign_id"), &campaign)
                && strict_str(field(Some(check), "actor_id"), &actor)
                && !js::present(field(Some(check), "invalidated_at"))
                && (strict_str(field(context, "kind"), "free_action") || strict_str(field(context, "kind"), "ability_action"))
                && js::truthy(field(context, "action"))
                && number(field(context, "state_version")) == version
                && !self.issued_roll_consumed(check)
        });
        let Some(entry) = entry else { return Ok(None) };
        let context = field(Some(entry), "context");
        let mut result = Map::new();
        let mut put = |key: &str, value: Option<&Value>| {
            if let Some(value) = value {
                result.insert(key.into(), value.clone());
            }
        };
        put("check_id", field(Some(entry), "check_id"));
        put("label", field(Some(entry), "label"));
        put("modifier", field(Some(entry), "modifier"));
        put("difficulty", field(Some(entry), "difficulty"));
        put("sides", Some(&Value::from(20)));
        put("ability", field(Some(entry), "ability"));
        put("skill", nullish(field(field(context, "reading"), "skill"), field(context, "skill")));
        put("advantage", field(Some(entry), "advantage"));
        put("disadvantage", field(Some(entry), "disadvantage"));
        put("action", field(context, "action"));
        put("proposal", field(context, "proposal"));
        Ok(Some(Value::Object(result)))
    }

    /// Выдаёт кость для объявленной проверки. Аудит PR #131, SEC-01: прежде
    /// `check_id` был необязательным, и реестр выдавал «ничейный» бросок с
    /// параметрами клиента; обычная проверка принимала его `roll_id`, так что
    /// игрок мог бросать серию и подставить лучший. Теперь кость рождается только
    /// под зарегистрированную карточку, одна на карточку, и параметры берутся из
    /// неё. Свободный кубик стола — отдельный путь `/api/rooms/:code/dice`, в
    /// механику он не попадает.
    pub fn issue(&mut self, options: &Value) -> Result<Value, RollRegistryError> {
        self.cleanup()?;
        let option = |key: &str| field(Some(options), key);
        let registered_id = nullish(option("checkId"), option("check_id"));
        if !js::truthy(registered_id) {
            return Err(rejected("CHECK_REQUIRED", "Механический бросок выдаётся только для объявленной проверки"));
        }
        let check_key = js::s(registered_id);
        let registered = self
            .checks
            .get(&check_key)
            .filter(|check| js::truthy(Some(check)))
            .cloned()
            .ok_or_else(|| rejected("CHECK_NOT_FOUND", "Проверка не найдена или истекла"))?;
        Self::assert_owner(&registered, options, "Проверка принадлежит другому ходу или персонажу", "CHECK_FORBIDDEN")?;
        if js::present(field(Some(&registered), "invalidated_at")) {
            return Err(rejected("CHECK_INVALIDATED", "Эта проверка отменена: заявка была изменена"));
        }
        // Повтор HTTP-запроса после потери ответа возвращает ту же кость.
        // Связь хранится вместе с реестром и переживает перезапуск.
        let issued_id = field(Some(&registered), "issued_roll_id");
        if js::truthy(issued_id) {
            let issued = match issued_id {
                Some(Value::String(id)) => self.rolls.get(id).filter(|roll| js::truthy(Some(roll))),
                _ => None,
            };
            let Some(issued) = issued else {
                return Err(rejected("ROLL_NOT_FOUND", "Выданный бросок истёк"));
            };
            return Ok(field(Some(issued), "result").cloned().unwrap_or(Value::Null));
        }
        let entry_field = |key: &str| field(Some(&registered), key);
        let label = sk_core::text::head(&template(entry_field("label")), 80);
        // `rollCheck` проверяет СЛ раньше модификатора — порядок отказов тот же.
        let difficulty = number(entry_field("difficulty"));
        if !is_safe_integer(difficulty) || !(0.0..=100.0).contains(&difficulty) {
            return Err(DiceError::Expression("Некорректная сложность проверки".into()).into());
        }
        let modifier = number(entry_field("modifier"));
        if !is_safe_integer(modifier) {
            return Err(DiceError::Expression("Некорректный модификатор d20".into()).into());
        }
        let visibility = match entry_field("visibility") {
            Some(Value::String(text)) => Visibility::parse_lenient(text),
            _ => Visibility::Public,
        };
        let request = D20Request::new(label.clone(), modifier as i64)
            .actor(template(option("actorId")))
            .advantage(js::truthy(entry_field("advantage")))
            .disadvantage(js::truthy(entry_field("disadvantage")))
            .visibility(visibility);
        let roll = self.dice.roll_check(&request, difficulty as i64)?;
        let roll_id = roll.roll_id.clone();
        let mut result = match serde_json::to_value(&roll) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        result.insert("label".into(), Value::String(label));
        if let Some(ability) = entry_field("ability") {
            result.insert("ability".into(), ability.clone());
        }
        let mut entry = Map::new();
        entry.insert("result".into(), Value::Object(result.clone()));
        if let Some(context) = entry_field("context").filter(|context| js::truthy(Some(context))) {
            entry.insert("context".into(), context.clone());
        }
        // Обратная связь «бросок → карточка»: по ней `consume` отличает
        // механический бросок от ничейного (аудит PR #131, SEC-01).
        entry.insert("check_id".into(), Value::String(check_key.clone()));
        entry.insert("campaign_id".into(), Value::String(string_or_empty(option("campaignId"))));
        entry.insert("actor_id".into(), Value::String(string_or_empty(option("actorId"))));
        entry.insert("expires_at".into(), Value::from(self.now() + self.ttl_ms));
        entry.insert("consumed_by".into(), Value::Null);
        self.rolls.insert(roll_id.clone(), Value::Object(entry));
        if let Some(Value::Object(check)) = self.checks.get_mut(&check_key) {
            check.insert("issued_roll_id".into(), Value::String(roll_id));
        }
        self.persist()?;
        Ok(Value::Object(result))
    }

    /// `consume(rollId, { campaignId, actorId, idempotencyKey, validateContext })`.
    ///
    /// `validate_context` получает служебный контекст броска (`null`, если его
    /// нет); отказ прерывает потребление без изменений реестра.
    pub fn consume(
        &mut self,
        roll_id: &Value,
        options: &Value,
        validate_context: Option<&mut dyn FnMut(&Value) -> Result<(), RuleError>>,
    ) -> Result<Value, RollRegistryError> {
        self.cleanup()?;
        let key_id = string_or_empty(Some(roll_id));
        let entry = self
            .rolls
            .get(&key_id)
            .filter(|entry| js::truthy(Some(entry)))
            .ok_or_else(|| rejected("ROLL_NOT_FOUND", "Бросок не найден или истёк"))?;
        Self::assert_owner(entry, options, "Бросок принадлежит другому ходу или персонажу", "ROLL_FORBIDDEN")?;
        if js::present(field(Some(entry), "invalidated_at")) {
            return Err(rejected("ROLL_INVALIDATED", "Этот бросок отменён: заявка была изменена"));
        }
        let key = string_or_empty(field(Some(options), "idempotencyKey"));
        let consumed_by = field(Some(entry), "consumed_by");
        if js::truthy(consumed_by) && !strict_str(consumed_by, &key) {
            return Err(rejected("ROLL_ALREADY_USED", "Бросок уже использован"));
        }
        // Аудит PR #131, SEC-01: ничейный бросок механикой не потребляется. Такие
        // записи могли остаться в durable-файле от выдачи до исправления; у
        // привязанных записей того времени нет поля `check_id`, и связь ищется по
        // карточке. Повтор того же ключа по уже потреблённой записи не трогаем:
        // он лишь возвращает прежний commit.
        if !js::truthy(consumed_by) && self.bound_check_id(&template(Some(roll_id)), entry).is_none() {
            return Err(rejected("ROLL_UNBOUND", "Бросок не относится ни к одной объявленной проверке"));
        }
        if let Some(validate) = validate_context {
            let context = field(Some(entry), "context").cloned().unwrap_or(Value::Null);
            validate(&context).map_err(RollRegistryError::Validation)?;
        }
        let consumed = if key.is_empty() { format!("used:{}", self.now()) } else { key };
        let entry = self.rolls.get_mut(&key_id).and_then(Value::as_object_mut).ok_or_else(|| rejected("ROLL_NOT_FOUND", "Бросок не найден или истёк"))?;
        entry.insert("consumed_by".into(), Value::String(consumed));
        // Аудит PR #131, SEC-04: исход хода ещё не известен (см. finish_reservation).
        entry.insert("commit_pending".into(), Value::Bool(true));
        let mut result = match entry.get("result") {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        if let Some(context) = entry.get("context").filter(|context| js::truthy(Some(context))) {
            result.insert("context".into(), context.clone());
        }
        self.persist()?;
        *self.reservation_holders.entry(template(Some(roll_id))).or_insert(0) += 1;
        Ok(Value::Object(result))
    }

    /// Аудит PR #131, SEC-04: `consume` помечает бросок потреблённым раньше, чем
    /// ход фиксируется в журнале. Если commit не состоялся (отказ движка, конфликт
    /// версии, сбой записи), пометка оставалась навсегда: другой ключ получал
    /// `ROLL_ALREADY_USED`, карточка проверки пропадала, а повтор с тем же ключом
    /// зависел от того, не сдвинулась ли обстановка.
    ///
    /// Теперь `consume` — резерв (`commit_pending`), а исход сообщает маршрут.
    /// `committed: true` — запрос завершён (ход в журнале, отвергнут по существу
    /// или исход неизвестен): бросок окончательно потреблён. `committed: false` —
    /// commit по этому ключу не состоялся: когда последний держатель резерва в
    /// процессе его отпустил, бросок снова доступен. Кость при этом та же —
    /// переброса нет, а применить её можно только одним commit. Резерв другого
    /// ключа и уже закреплённый резерв не трогаются.
    ///
    /// Возвращает, снят ли резерв.
    pub fn finish_reservation(&mut self, roll_id: &Value, options: &Value) -> Result<bool, RollRegistryError> {
        let id = string_or_empty(Some(roll_id));
        let holders = self.reservation_holders.get(&id).copied().unwrap_or(0);
        if holders <= 1 {
            self.reservation_holders.remove(&id);
        } else {
            self.reservation_holders.insert(id.clone(), holders - 1);
        }
        let key = string_or_empty(field(Some(options), "idempotencyKey"));
        let committed = match field(Some(options), "committed") {
            None => true,
            value => js::truthy(value),
        };
        let Some(entry) = self.rolls.get_mut(&id).filter(|entry| js::truthy(Some(entry))) else { return Ok(false) };
        if key.is_empty() || !strict_str(entry.get("consumed_by"), &key) || !js::is_true(entry.get("commit_pending")) {
            return Ok(false);
        }
        let Some(entry) = entry.as_object_mut() else { return Ok(false) };
        if committed {
            entry.shift_remove("commit_pending");
            self.persist()?;
            return Ok(false);
        }
        // Пока резерв держит другой запрос того же ключа, его commit ещё возможен.
        if holders > 1 {
            return Ok(false);
        }
        entry.insert("consumed_by".into(), Value::Null);
        entry.shift_remove("commit_pending");
        self.persist()?;
        Ok(true)
    }

    /// Аудит PR #131, SEC-04: восстановление после остановки процесса между
    /// `consume` и исходом хода. На старте держателей нет, поэтому незакреплённый
    /// резерв, чей ключ не дал commit, — осиротевший, и он снимается; с commit —
    /// закрепляется. Резерв с неизвестным исходом (ошибка чтения журнала —
    /// `Err` от `has_commit`) остаётся как есть: при сомнении защита от двойного
    /// применения важнее. Завершённые запросы (в том числе отвергнутые без
    /// commit) не пересматриваются.
    ///
    /// `has_commit(campaign_id, idempotency_key)` — есть ли commit с этим ключом.
    /// Журнал Rust синхронный, поэтому сверка идёт под тем же `&mut self`.
    /// Возвращает идентификаторы освобождённых бросков.
    pub fn release_orphan_reservations<E>(&mut self, mut has_commit: impl FnMut(&str, &str) -> Result<bool, E>) -> Result<Vec<String>, RollRegistryError> {
        self.cleanup()?;
        let mut released = Vec::new();
        let mut changed = false;
        let ids: Vec<String> = self.rolls.keys().cloned().collect();
        for id in ids {
            let Some(entry) = self.rolls.get(&id) else { continue };
            let key = js::s(field(Some(entry), "consumed_by"));
            // Потребление без ключа (`used:<время>`) с журналом не сверить.
            if !js::is_true(field(Some(entry), "commit_pending")) || key.is_empty() || key.starts_with("used:") || self.reservation_holders.contains_key(&id) {
                continue;
            }
            let campaign = js::s(field(Some(entry), "campaign_id"));
            let committed = match has_commit(&campaign, &key) {
                Ok(committed) => committed,
                Err(_) => continue,
            };
            let Some(entry) = self.rolls.get_mut(&id).and_then(Value::as_object_mut) else { continue };
            // Пока шла проверка, резерв мог снова взять запрос того же ключа.
            if !strict_str(entry.get("consumed_by"), &key) || !js::is_true(entry.get("commit_pending")) || self.reservation_holders.contains_key(&id) {
                continue;
            }
            entry.shift_remove("commit_pending");
            changed = true;
            if committed {
                continue;
            }
            entry.insert("consumed_by".into(), Value::Null);
            released.push(id);
        }
        if changed {
            self.persist()?;
        }
        Ok(released)
    }

    /// Карточка, под которую выдана кость, либо `None` для ничейного броска.
    fn bound_check_id(&self, roll_id: &str, entry: &Value) -> Option<String> {
        let check_id = field(Some(entry), "check_id");
        if js::truthy(check_id) {
            return Some(js::s(check_id));
        }
        self.checks.iter().find(|(_, check)| strict_str(field(Some(check), "issued_roll_id"), roll_id)).map(|(id, _)| id.clone())
    }

    /// Отменяет карточку до выдачи кости. После выдачи редактирование запрещено:
    /// потерянный ответ возвращает прежнюю кость и не даёт бесплатного переброса.
    pub fn invalidate_check(&mut self, check_id: &Value, options: &Value) -> Result<bool, RollRegistryError> {
        self.cleanup()?;
        let id = string_or_blank(Some(check_id));
        let check = self
            .checks
            .get(&id)
            .filter(|check| js::truthy(Some(check)))
            .ok_or_else(|| rejected("CHECK_NOT_FOUND", "Проверка не найдена или истекла"))?;
        Self::assert_owner(check, options, "Проверка принадлежит другому ходу или персонажу", "CHECK_FORBIDDEN")?;
        if js::present(field(Some(check), "invalidated_at")) {
            return Ok(false);
        }
        if js::truthy(field(Some(check), "issued_roll_id")) {
            return Err(rejected(
                "CHECK_ALREADY_ROLLED",
                "Кость уже брошена: изменить эту заявку нельзя. Повторите отправку прежнего результата.",
            ));
        }
        let reason = match field(Some(options), "reason") {
            None => "proposal-edited".to_string(),
            value => template(value),
        };
        let now = self.now();
        if let Some(Value::Object(check)) = self.checks.get_mut(&id) {
            check.insert("invalidated_at".into(), Value::from(now));
            check.insert("invalidated_reason".into(), Value::String(sk_core::text::head(&reason, 80)));
        }
        self.persist()?;
        Ok(true)
    }

    /// Отменяет карточку по её публичному `proposal_id` или `check_id`.
    pub fn invalidate_proposal(&mut self, proposal_id: &Value, options: &Value) -> Result<bool, RollRegistryError> {
        self.cleanup()?;
        let wanted = string_or_blank(Some(proposal_id));
        let matches: Vec<String> = self
            .checks
            .iter()
            .filter(|(id, check)| **id == wanted || js::s(field(field(Some(check), "context"), "proposal_id")) == wanted)
            .map(|(id, _)| id.clone())
            .collect();
        if matches.is_empty() {
            return Err(rejected("CHECK_NOT_FOUND", "Предложение проверки не найдено или истекло"));
        }
        let mut changed = false;
        for id in matches {
            changed = self.invalidate_check(&Value::String(id), options)? || changed;
        }
        Ok(changed)
    }
}

fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

fn entries_value(map: &IndexMap<String, Value>) -> Value {
    Value::Array(map.iter().map(|(id, entry)| json!([id, entry])).collect())
}

/// `new Map(list.map(([id, entry]) => [String(id), entry]))`.
fn pairs(items: &[Value]) -> Result<IndexMap<String, Value>, RollRegistryError> {
    let mut map = IndexMap::new();
    for item in items {
        // Деструктуризация JS: массив — по элементам, строка — по символам,
        // остальное не итерируется (`TypeError`).
        let (id, entry) = match item {
            Value::Array(pair) => (pair.first().cloned(), pair.get(1).cloned()),
            Value::String(text) => {
                let mut chars = text.chars().map(|ch| Value::String(ch.to_string()));
                (chars.next(), chars.next())
            }
            _ => return Err(RollRegistryError::Type("Некорректная запись durable-хранилища бросков: элемент не является парой [id, запись]".into())),
        };
        // `cleanup()` в конструкторе читает `entry.expires_at`: у `null` и
        // отсутствующей записи JS падает `TypeError`.
        let entry = match entry {
            None | Some(Value::Null) => {
                return Err(RollRegistryError::Type(format!(
                    "Cannot read properties of {} (reading 'expires_at')",
                    if entry.is_none() { "undefined" } else { "null" }
                )))
            }
            Some(entry) => entry,
        };
        map.insert(template(id.as_ref()), entry);
    }
    Ok(map)
}

//! С16: отпечатки команд `/commands` для идемпотентности — перенос
//! `server/index.mjs` 648–661 (`merchantCommandFingerprint`, нужен
//! санитайзеру торговли С16; С14 берёт его отсюда же) и 662–993: отпечатки
//! предмета, атаки, отдыха, обыска и развития героя, сверка повтора ключа
//! (`assert*Idempotency`) и итога коммита (`assert*ResultFingerprint`).
//!
//! Отпечаток — SHA-256 строки `JSON.stringify` смыслового объекта, поэтому
//! порядок ключей и запись чисел — как в JS ([`js::stringify`]).
//!
//! Журнал в JS читается асинхронно (`eventStore.getByIdempotencyKey`), в Rust
//! журнал зовётся синхронно на потоке ядра (`core.rs`), поэтому сверки
//! повтора — синхронные функции над трейтом [`DuplicateLookup`]. Повтор
//! приходит в форме JS (`CommitResult::to_json`: `events`, `state`, …).

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{js, text};

use crate::command_guard::{command_type, get, list, nn, policy_error, GuardResult};
use crate::error::Failure;

/// SHA-256 строки `JSON.stringify(semantic)`.
pub(crate) fn digest(semantic: &Value) -> String {
    sk_core::hash::sha256_hex(js::stringify(semantic).as_bytes())
}

/// `String(x ?? '')` поля команды.
fn field(command: &Value, key: &str) -> String {
    js::s(get(Some(command), key))
}

/// `Number(x)` в JSON (`NaN` — `null`, как `JSON.stringify`).
fn number_value(value: Option<&Value>) -> Value {
    js::num(js::number(value))
}

/// `Number(x ?? fallback)`.
fn number_or(value: Option<&Value>, fallback: f64) -> Value {
    if js::present(value) {
        number_value(value)
    } else {
        js::num(fallback)
    }
}

/// Строковые ключи в порядке `Array.prototype.sort()` без сравнителя: по
/// единицам UTF-16, а не по кодовым точкам.
fn sort_utf16(values: &mut [String]) {
    values.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
}

/// `[...new Set(list ?? [])].map(String).sort()`.
///
/// `Set` сравнивает как `SameValueZero`: примитивы по значению, объекты и
/// массивы — по ссылке (каждый свой). Строка итерируется по кодовым точкам.
/// Число или объект вместо списка в JS — `TypeError` (не итерируется); до
/// отпечатка такое не доходит (санитайзер кладёт массивы), здесь — пустой
/// список.
fn sorted_unique_strings(value: Option<&Value>) -> Value {
    let items: Vec<Value> = match value {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text.chars().map(|ch| Value::String(ch.to_string())).collect(),
        _ => Vec::new(),
    };
    let mut unique: Vec<&Value> = Vec::new();
    for item in &items {
        let seen = match item {
            Value::Array(_) | Value::Object(_) => false,
            Value::Number(number) => unique.iter().any(|other| matches!(other, Value::Number(known) if known.as_f64() == number.as_f64())),
            primitive => unique.iter().any(|other| *other == primitive),
        };
        if !seen {
            unique.push(item);
        }
    }
    let mut strings: Vec<String> = unique.into_iter().map(|item| js::string(Some(item))).collect();
    sort_utf16(&mut strings);
    js::strings_value(strings)
}

/// `merchantCommandFingerprint(command)` (648–661).
pub fn merchant_command_fingerprint(command: &Value) -> String {
    let kind = command_type(command);
    let mut semantic = Map::new();
    semantic.insert("type".into(), Value::String(kind.clone()));
    semantic.insert("actor_id".into(), Value::String(field(command, "actor_id")));
    semantic.insert("merchant_id".into(), Value::String(field(command, "merchant_id")));
    match kind.as_str() {
        "BuyItem" => {
            semantic.insert("stock_id".into(), Value::String(field(command, "stock_id")));
            semantic.insert("quantity".into(), number_value(get(Some(command), "quantity")));
        }
        "SellItem" => {
            semantic.insert("item_id".into(), Value::String(field(command, "item_id")));
            semantic.insert("quantity".into(), number_value(get(Some(command), "quantity")));
        }
        "AppraiseItem" => {
            semantic.insert("item_id".into(), Value::String(field(command, "item_id")));
        }
        "PurchaseMerchantService" => {
            semantic.insert("service_id".into(), Value::String(field(command, "service_id")));
        }
        _ => {}
    }
    digest(&Value::Object(semantic))
}

/// `itemCommandFingerprint(command)` (662–688).
pub fn item_command_fingerprint(command: &Value) -> String {
    let kind = command_type(command);
    let source = Some(command);
    let mut semantic = Map::new();
    semantic.insert("type".into(), Value::String(kind.clone()));
    semantic.insert("actor_id".into(), Value::String(field(command, "actor_id")));
    semantic.insert("item_id".into(), Value::String(field(command, "item_id")));
    match kind.as_str() {
        "EquipItem" => {
            semantic.insert("equipped".into(), Value::Bool(!js::is_false(get(source, "equipped"))));
            if get(source, "equip_slot").and_then(Value::as_str) == Some("off_hand") {
                semantic.insert("equip_slot".into(), json!("off_hand"));
            }
        }
        "AttuneItem" => {
            semantic.insert("attuned".into(), Value::Bool(!js::is_false(get(source, "attuned"))));
        }
        "ActivateItem" => {
            semantic.insert("activated".into(), Value::Bool(js::is_true(get(source, "activated"))));
        }
        "UseItem" => {
            semantic.insert("target_id".into(), Value::String(js::s(nn(get(source, "target_id"), get(source, "actor_id")))));
            semantic.insert("charges_to_spend".into(), number_or(get(source, "charges_to_spend"), 0.0));
            let to = get(source, "to");
            let point = if js::present(to) {
                json!({ "x": number_value(get(to, "x")), "y": number_value(get(to, "y")) })
            } else {
                Value::Null
            };
            semantic.insert("to".into(), point);
            semantic.insert("use_mode".into(), Value::String(field(command, "use_mode")));
            semantic.insert("weapon_id".into(), Value::String(field(command, "weapon_id")));
        }
        "TransferItem" => {
            semantic.insert("recipient_id".into(), Value::String(field(command, "recipient_id")));
            semantic.insert("quantity".into(), number_or(get(source, "quantity"), 1.0));
        }
        _ => {}
    }
    digest(&Value::Object(semantic))
}

/// `makeAttackCommandFingerprint(command)` (689–701).
pub fn make_attack_command_fingerprint(command: &Value) -> String {
    let source = Some(command);
    digest(&json!({
        "type": "MakeAttack",
        "actor_id": field(command, "actor_id"),
        "target_id": field(command, "target_id"),
        "item_id": field(command, "item_id"),
        "attack_mode": field(command, "attack_mode"),
        "attack_ability": field(command, "attack_ability"),
        "sneak_attack": js::is_true(get(source, "sneak_attack")),
        "knock_out": js::is_true(get(source, "knock_out")),
    }))
}

/// `makeAttackPrimaryEvent(event)` (747–750).
fn make_attack_primary_event(event: &Value) -> bool {
    let kind = get(Some(event), "event_type").and_then(Value::as_str);
    kind == Some("AttackResolved") || (kind == Some("CombatActionUsed") && get(get(Some(event), "payload"), "action_id").and_then(Value::as_str) == Some("sanctuary-blocked"))
}

/// `makeAttackEventFingerprints(events)` (758–764): отпечатки атак коммита;
/// удар из исследования, отложенный до хода героя, несёт `CombatStarted`.
pub fn make_attack_event_fingerprints(events: Option<&Value>) -> Vec<String> {
    let mut found: Vec<Option<&Value>> = Vec::new();
    for event in list(events) {
        if make_attack_primary_event(event) {
            found.push(get(get(Some(event), "payload"), "request_fingerprint"));
            continue;
        }
        let opening = if get(Some(event), "event_type").and_then(Value::as_str) == Some("CombatStarted") {
            get(get(Some(event), "payload"), "opening_action")
        } else {
            None
        };
        if get(opening, "status").and_then(Value::as_str) == Some("deferred") && get(opening, "command_type").and_then(Value::as_str) == Some("MakeAttack") {
            found.push(get(opening, "request_fingerprint"));
        }
    }
    found.into_iter().filter(|value| js::truthy(*value)).map(js::string).collect()
}

/// Журнал для сверки повтора ключа: `eventStore.getByIdempotencyKey`.
pub trait DuplicateLookup {
    /// Подтверждённый коммит под ключом в форме JS (`events`, `state`, …)
    /// или `None`; ошибка хранилища уходит наружу, как исключение JS.
    fn get_by_idempotency_key(&self, campaign_id: &str, idempotency_key: &str) -> Result<Option<Value>, Failure>;
}

impl DuplicateLookup for sk_store::EventStore {
    fn get_by_idempotency_key(&self, campaign_id: &str, idempotency_key: &str) -> Result<Option<Value>, Failure> {
        Ok(sk_store::EventStore::get_by_idempotency_key(self, campaign_id, idempotency_key)?.map(|commit| commit.to_json()))
    }
}

impl<F> DuplicateLookup for F
where
    F: Fn(&str, &str) -> Result<Option<Value>, Failure>,
{
    fn get_by_idempotency_key(&self, campaign_id: &str, idempotency_key: &str) -> Result<Option<Value>, Failure> {
        self(campaign_id, idempotency_key)
    }
}

/// Проверка прав на найденный повтор (`authorizeDuplicate`): получает
/// сохранённый коммит, отказ — ошибкой.
pub type AuthorizeDuplicate<'a> = dyn FnMut(&Value) -> GuardResult<()> + 'a;

fn same_sequence(actual: &[String], expected: &[String]) -> bool {
    actual.len() == expected.len() && expected.iter().zip(actual).all(|(left, right)| left == right)
}

fn make_attack_expected(commands: &[Value]) -> Vec<String> {
    commands.iter().filter(|command| command_type(command) == "MakeAttack").map(make_attack_command_fingerprint).collect()
}

/// `assertMakeAttackIdempotency(campaignId, key, commands, { authorizeDuplicate })`
/// (766–784): `true` — точный повтор, `false` — атак нет или ключ свободен.
/// Права проверяются до сравнения отпечатков, чтобы чужой не отличил точный
/// ключ от конфликтующего.
pub fn assert_make_attack_idempotency(journal: &dyn DuplicateLookup, campaign_id: &str, idempotency_key: &str, commands: &[Value], authorize: Option<&mut AuthorizeDuplicate<'_>>) -> GuardResult<bool> {
    let expected = make_attack_expected(commands);
    if expected.is_empty() {
        return Ok(false);
    }
    let Some(duplicate) = journal.get_by_idempotency_key(campaign_id, idempotency_key)? else {
        return Ok(false);
    };
    if let Some(authorize) = authorize {
        authorize(&duplicate)?;
    }
    let actual = make_attack_event_fingerprints(get(Some(&duplicate), "events"));
    if !same_sequence(&actual, &expected) {
        return Err(policy_error("Этот ключ идемпотентности уже использован для другой атаки", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(true)
}

/// `assertMakeAttackResultFingerprint(result, commands)` (786–795).
pub fn assert_make_attack_result_fingerprint(result: &Value, commands: &[Value]) -> GuardResult<()> {
    let expected = make_attack_expected(commands);
    if expected.is_empty() {
        return Ok(());
    }
    let actual = make_attack_event_fingerprints(get(Some(result), "mechanics"));
    if !same_sequence(&actual, &expected) {
        return Err(policy_error("Результат атаки не соответствует исходному запросу", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

/// События, чей `payload.request_fingerprint` подтверждает вход в бой с NPC.
pub const NPC_COMBAT_PRIMARY_EVENT_TYPES: &[&str] = &["EncounterCreated"];
/// События отдыха с отпечатком запроса.
pub const REST_PRIMARY_EVENT_TYPES: &[&str] = &["RestStarted", "HitPointDieSpent", "RestCompleted"];
/// События действий с предметом с отпечатком запроса.
pub const ITEM_PRIMARY_EVENT_TYPES: &[&str] = &["ItemEquipped", "ItemUnequipped", "ItemTransferred", "ItemAttunementChanged", "ItemUsed", "MagicItemActivationChanged"];
/// Событие обыска с отпечатком запроса.
pub const LOOT_PRIMARY_EVENT_TYPES: &[&str] = &["LootContainerTaken"];
/// События развития героя с отпечатком запроса.
const CHARACTER_BUILD_EVENT_TYPES: &[&str] = &["CharacterChoicesUpdated", "SpellSelectionsUpdated"];

/// `types.has(event.event_type)` — строгое сравнение строки.
fn event_in(event: &Value, types: &[&str]) -> bool {
    get(Some(event), "event_type").and_then(Value::as_str).is_some_and(|kind| types.contains(&kind))
}

/// Первичные события повтора.
fn primary_events<'a>(duplicate: &'a Value, types: &[&str]) -> Vec<&'a Value> {
    list(get(Some(duplicate), "events")).iter().filter(|event| event_in(event, types)).collect()
}

/// `new Set(events.map((e) => e.payload?.request_fingerprint).filter(Boolean).map(String))`.
fn fingerprint_set(events: &[&Value]) -> IndexSet<String> {
    events.iter().map(|event| get(get(Some(event), "payload"), "request_fingerprint")).filter(|value| js::truthy(*value)).map(js::string).collect()
}

/// `fingerprints.size !== 1 || !fingerprints.has(expected)`.
fn single_mismatch(fingerprints: &IndexSet<String>, expected: &str) -> bool {
    fingerprints.len() != 1 || !fingerprints.contains(expected)
}

/// Сверка «первое первичное событие итога несёт ожидаемый отпечаток»
/// (`assert*ResultFingerprint`).
fn result_mismatch(result: &Value, types: &[&str], expected: &str) -> bool {
    let event = list(get(Some(result), "mechanics")).iter().find(|event| event_in(event, types));
    match event {
        None => true,
        Some(event) => js::s(get(get(Some(event), "payload"), "request_fingerprint")) != expected,
    }
}

/// Общая сверка повтора с одним первичным отпечатком.
fn assert_single_idempotency(journal: &dyn DuplicateLookup, campaign_id: &str, idempotency_key: &str, types: &[&str], expected: impl FnOnce() -> String, message: &str) -> GuardResult<()> {
    let Some(duplicate) = journal.get_by_idempotency_key(campaign_id, idempotency_key)? else {
        return Ok(());
    };
    let fingerprints = fingerprint_set(&primary_events(&duplicate, types));
    if single_mismatch(&fingerprints, &expected()) {
        return Err(policy_error(message, "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

/// `assertNpcCombatIdempotency(campaignId, key, command)` (828–839).
pub fn assert_npc_combat_idempotency(journal: &dyn DuplicateLookup, campaign_id: &str, idempotency_key: &str, command: &Value) -> GuardResult<()> {
    assert_single_idempotency(journal, campaign_id, idempotency_key, NPC_COMBAT_PRIMARY_EVENT_TYPES, || sk_rules::combat::encounter::npc_combat_request_fingerprint(command), "Этот ключ идемпотентности уже использован для другого входа в бой")
}

/// `assertNpcCombatResultFingerprint(result, command)` (841–846).
pub fn assert_npc_combat_result_fingerprint(result: &Value, command: &Value) -> GuardResult<()> {
    if result_mismatch(result, NPC_COMBAT_PRIMARY_EVENT_TYPES, &sk_rules::combat::encounter::npc_combat_request_fingerprint(command)) {
        return Err(policy_error("Результат входа в бой не соответствует исходному запросу", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

/// `restCommandFingerprint(command)` (848–856).
pub fn rest_command_fingerprint(command: &Value) -> String {
    let kind = command_type(command);
    let mut semantic = Map::new();
    semantic.insert("type".into(), Value::String(kind.clone()));
    semantic.insert("actor_id".into(), Value::String(field(command, "actor_id")));
    if kind == "StartRest" {
        let long = get(Some(command), "kind").and_then(Value::as_str) == Some("long");
        semantic.insert("kind".into(), json!(if long { "long" } else { "short" }));
    } else {
        semantic.insert("rest_id".into(), Value::String(field(command, "rest_id")));
    }
    digest(&Value::Object(semantic))
}

/// `assertRestIdempotency(campaignId, key, command)` (860–879). Как в JS,
/// правит `command` на месте: повтор `SpendHitPointDie`/`CompleteRest` без
/// `rest_id` получает `rest_id` единственного отдыха повтора и новый
/// `request_fingerprint`.
pub fn assert_rest_idempotency(journal: &dyn DuplicateLookup, campaign_id: &str, idempotency_key: &str, command: &mut Value) -> GuardResult<()> {
    let Some(duplicate) = journal.get_by_idempotency_key(campaign_id, idempotency_key)? else {
        return Ok(());
    };
    let primary = primary_events(&duplicate, REST_PRIMARY_EVENT_TYPES);
    if command_type(command) != "StartRest" && !js::truthy(get(Some(command), "rest_id")) {
        let rest_ids: IndexSet<String> = primary.iter().map(|event| get(get(Some(event), "payload"), "rest_id")).filter(|value| js::truthy(*value)).map(js::string).collect();
        if rest_ids.len() == 1 {
            if let Some(rest_id) = rest_ids.first() {
                if let Some(map) = command.as_object_mut() {
                    map.insert("rest_id".into(), Value::String(rest_id.clone()));
                }
                let fingerprint = rest_command_fingerprint(command);
                if let Some(map) = command.as_object_mut() {
                    map.insert("request_fingerprint".into(), Value::String(fingerprint));
                }
            }
        }
    }
    let fingerprints = fingerprint_set(&primary);
    if single_mismatch(&fingerprints, &rest_command_fingerprint(command)) {
        return Err(policy_error("Этот ключ идемпотентности уже использован для другого действия отдыха", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

/// `assertRestResultFingerprint(result, command)` (881–887).
pub fn assert_rest_result_fingerprint(result: &Value, command: &Value) -> GuardResult<()> {
    if result_mismatch(result, REST_PRIMARY_EVENT_TYPES, &rest_command_fingerprint(command)) {
        return Err(policy_error("Результат отдыха не соответствует исходному запросу", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

/// `assertItemIdempotency(campaignId, key, command)` (891–902).
pub fn assert_item_idempotency(journal: &dyn DuplicateLookup, campaign_id: &str, idempotency_key: &str, command: &Value) -> GuardResult<()> {
    assert_single_idempotency(journal, campaign_id, idempotency_key, ITEM_PRIMARY_EVENT_TYPES, || item_command_fingerprint(command), "Этот ключ идемпотентности уже использован для другого действия с предметом")
}

/// `assertItemResultFingerprint(result, command)` (904–909).
pub fn assert_item_result_fingerprint(result: &Value, command: &Value) -> GuardResult<()> {
    if result_mismatch(result, ITEM_PRIMARY_EVENT_TYPES, &item_command_fingerprint(command)) {
        return Err(policy_error("Результат действия с предметом не соответствует исходному запросу", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

/// `lootCommandFingerprint(command)` (918–932): строки сортируются
/// (`localeCompare`), «кинжал и стрелы» и «стрелы и кинжал» — один запрос.
pub fn loot_command_fingerprint(command: &Value) -> String {
    let source = Some(command);
    let mut lines: Vec<(String, Value)> = list(get(source, "lines"))
        .iter()
        .map(|line| (js::s(get(Some(line), "item_instance_id")), number_or(get(Some(line), "quantity"), 1.0)))
        .collect();
    lines.sort_by(|left, right| text::locale_compare(&left.0, &right.0));
    let lines: Vec<Value> = lines.into_iter().map(|(id, quantity)| json!({ "item_instance_id": id, "quantity": quantity })).collect();
    digest(&json!({
        "type": "LootContainer",
        "actor_id": field(command, "actor_id"),
        "container_id": field(command, "container_id"),
        "recipient_id": js::s(nn(get(source, "recipient_id"), get(source, "actor_id"))),
        "lines": lines,
    }))
}

/// `assertLootIdempotency(campaignId, key, command)` (939–950).
pub fn assert_loot_idempotency(journal: &dyn DuplicateLookup, campaign_id: &str, idempotency_key: &str, command: &Value) -> GuardResult<()> {
    assert_single_idempotency(journal, campaign_id, idempotency_key, LOOT_PRIMARY_EVENT_TYPES, || loot_command_fingerprint(command), "Этот ключ идемпотентности уже использован для другого обыска")
}

/// `assertLootResultFingerprint(result, command)` (952–957).
pub fn assert_loot_result_fingerprint(result: &Value, command: &Value) -> GuardResult<()> {
    if result_mismatch(result, LOOT_PRIMARY_EVENT_TYPES, &loot_command_fingerprint(command)) {
        return Err(policy_error("Результат обыска не соответствует исходному запросу", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

/// `characterBuildFingerprint(command)` (959–983).
pub fn character_build_fingerprint(command: &Value) -> String {
    let source = Some(command);
    let semantic = if command_type(command) == "SetCharacterChoices" {
        let level = get(source, "ability_score_level");
        let increases = get(source, "ability_score_increases");
        let feat = get(source, "ability_score_feat");
        json!({
            "command_type": "SetCharacterChoices",
            "actor_id": field(command, "actor_id"),
            "subclass": field(command, "subclass"),
            "class_skill_proficiencies": sorted_unique_strings(get(source, "class_skill_proficiencies")),
            "selected_feature_ids": sorted_unique_strings(get(source, "selected_feature_ids")),
            "ability_score_level": if js::present(level) { number_value(level) } else { Value::Null },
            "ability_score_increases": match increases {
                Some(Value::Array(items)) => js::strings_value(items.iter().map(|item| js::string(Some(item)))),
                _ => Value::Array(Vec::new()),
            },
            "ability_score_feat": if js::present(feat) {
                json!({
                    "id": js::s(get(feat, "id")),
                    "choices": get(feat, "choices").filter(|value| !value.is_null()).cloned().unwrap_or_else(js::obj),
                })
            } else {
                Value::Null
            },
        })
    } else {
        json!({
            "command_type": "SetSpellSelections",
            "actor_id": field(command, "actor_id"),
            "known_spell_ids": sorted_unique_strings(get(source, "known_spell_ids")),
            "prepared_spell_ids": sorted_unique_strings(get(source, "prepared_spell_ids")),
        })
    };
    digest(&semantic)
}

/// `assertCharacterBuildResultFingerprint(result, commands)` (985–993):
/// множества отпечатков заявки и итога совпадают.
pub fn assert_character_build_result_fingerprint(result: &Value, commands: &[Value]) -> GuardResult<()> {
    let expected: IndexSet<String> = commands.iter().map(character_build_fingerprint).collect();
    let actual: IndexSet<String> = list(get(Some(result), "mechanics"))
        .iter()
        .filter(|event| event_in(event, CHARACTER_BUILD_EVENT_TYPES))
        .map(|event| js::s(get(get(Some(event), "payload"), "request_fingerprint")))
        .collect();
    if actual.len() != expected.len() || expected.iter().any(|fingerprint| !actual.contains(fingerprint)) {
        return Err(policy_error("Этот ключ идемпотентности уже использован для другого изменения персонажа", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(())
}

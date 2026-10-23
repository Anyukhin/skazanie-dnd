//! С16: санитайзеры команд игрока `POST /campaigns/:id/commands` — перенос
//! `server/index.mjs`:
//!
//! - 510–526: `canUseHero` и его помощники над [`Caller`] (членство — трейт
//!   [`Memberships`]: ядро не зовёт `Accounts` синхронно, маршрут С18.1
//!   узнаёт ответ заранее в `core::blocking` и передаёт `bool`);
//! - 528–636: наборы команд, `LOOT_STALE_ERROR_CODES`, `lootTakenRecordFor`,
//!   `commandPolicyError`, `commandType`;
//! - 702–746, 797–826: база боевой команды, `normalizeMakeAttackCommand`,
//!   права и санитайзер входа в бой с NPC;
//! - 1247–2069: `combatActorFor`, права боевого актёра, все `sanitizePlayer*`,
//!   `expandPlayerRestCommand`, `withCourierReplyDraft` (модель — трейт
//!   [`CourierReplyModel`]) и `sanitizeMerchantCommand`.
//!
//! Санитайзер берёт из запроса только названные поля: путь, дальность,
//! СЛ, исход броска и прочие числа клиента сюда не проходят (инвариант
//! AGENTS.md §5 «клиентские поля недоверенные»). Отказ — [`Failure`] с
//! кодом и текстом JS байт в байт; `TypeError` JS на `null` в списках
//! состояния — [`Failure`] без кода с текстом V8.
//!
//! Длины и срезы строк — в единицах UTF-16, как `length`/`slice` JS
//! (предел тела запроса считается так же, решение ведущего №4).

use std::future::Future;
use std::pin::Pin;

use serde_json::{json, Map, Value};
use sk_core::{js, text};
use sk_rules::command::types as sets;

use crate::access::{campaign_membership, string_or_empty};
use crate::command_fingerprints::{character_build_fingerprint, item_command_fingerprint, loot_command_fingerprint, make_attack_command_fingerprint, merchant_command_fingerprint, rest_command_fingerprint};
use crate::error::Failure;

/// Итог санитайзера: команда для движка или отказ политики маршрута.
pub type GuardResult<T> = Result<T, Failure>;

// --- наборы команд (528–636) ---------------------------------------------------------

/// Грани общего кубика (`PUBLIC_DIE_SIDES`, 528; читает и С10).
pub const PUBLIC_DIE_SIDES: &[i64] = &[4, 6, 8, 10, 12, 20, 100];
/// Безопасные команды на тактической доске (`PLAYER_COMBAT_COMMANDS`).
pub const PLAYER_COMBAT_COMMANDS: &[&str] = &[
    "StartCombat", "AttackNpc", "MoveActor", "MakeAttack", "MakeAreaAttack", "ChangeWeapon", "CastSpell", "UseCombatAction", "SetSpellBonusPreference", "SetReactionPreference", "IdentifyEnemy",
    "ProposeParley", "SettleParley", "OperateDoor", "OperateSceneObject", "UseLevelTransition", "EndTurn", "ResolveHeroDeath",
];
/// Вход в бой с NPC (`PLAYER_NPC_COMBAT_COMMANDS`).
pub const PLAYER_NPC_COMBAT_COMMANDS: &[&str] = &["AttackNpc"];
/// Отдых (`PLAYER_REST_COMMANDS`).
pub const PLAYER_REST_COMMANDS: &[&str] = &["StartRest", "SpendHitPointDie", "CompleteRest"];
/// Развитие героя (`PLAYER_CHARACTER_COMMANDS`).
pub const PLAYER_CHARACTER_COMMANDS: &[&str] = &["SetCharacterChoices", "SetSpellSelections"];
/// Жизненный цикл листа героя (`PLAYER_CHARACTER_LIFECYCLE_COMMANDS`).
pub const PLAYER_CHARACTER_LIFECYCLE_COMMANDS: &[&str] = &["LevelUp", "ImportCharacter", "RollCharacterAbilities", "RollCharacterWealth"];
/// Действия с предметом (`PLAYER_ITEM_COMMANDS`).
pub const PLAYER_ITEM_COMMANDS: &[&str] = &["EquipItem", "UseItem", "TransferItem", "AttuneItem", "ActivateItem"];
/// Торговля игрока (`PLAYER_MERCHANT_COMMANDS`).
pub const PLAYER_MERCHANT_COMMANDS: &[&str] = &["BargainWithMerchant", "AppraiseItem", "BuyItem", "SellItem", "PurchaseMerchantService"];
/// Карманная кража (`PLAYER_PICKPOCKET_COMMANDS`).
pub const PLAYER_PICKPOCKET_COMMANDS: &[&str] = &["PickpocketNpc"];
/// Действия с пленным (`CAPTIVE_PLAYER_COMMAND_TYPES`).
pub const PLAYER_CAPTIVE_COMMANDS: &[&str] = &sets::CAPTIVE_PLAYER_COMMAND_TYPES;
/// Приручение зверя (`BEAST_PLAYER_COMMAND_TYPES`).
pub const PLAYER_BEAST_COMMANDS: &[&str] = &sets::BEAST_COMMAND_TYPES;
/// Ответ страже (`PLAYER_LAW_COMMANDS`).
pub const PLAYER_LAW_COMMANDS: &[&str] = &["ResolveGuardEncounter"];
/// Обыск контейнера (`PLAYER_LOOT_COMMANDS`).
pub const PLAYER_LOOT_COMMANDS: &[&str] = &["LootContainer"];
/// Отказы обыска, после которых карточка добычи обязана перерисоваться
/// (`LOOT_STALE_ERROR_CODES`).
pub const LOOT_STALE_ERROR_CODES: &[&str] = &["LOOT_ITEM_GONE", "LOOT_QUANTITY_INVALID", "LOOT_CONTAINER_EMPTY", "LOOT_CONTAINER_NOT_FOUND", "LOOT_CONTAINER_NOT_IN_SCENE"];
/// Досуг таверны (`TAVERN_COMMAND_TYPES`).
pub const PLAYER_TAVERN_COMMANDS: &[&str] = &sets::TAVERN_COMMAND_TYPES;
/// Письма (`COURIER_LETTER_COMMAND_TYPES`).
pub const PLAYER_LETTER_COMMANDS: &[&str] = &sets::COURIER_LETTER_COMMAND_TYPES;
/// Благословения (`BLESSING_COMMAND_TYPES`).
pub const PLAYER_BLESSING_COMMANDS: &[&str] = &sets::BLESSING_COMMAND_TYPES;
/// Вариант авторского разговора (`DIALOGUE_COMMAND_TYPE`).
pub const PLAYER_DIALOGUE_COMMANDS: &[&str] = &[sets::DIALOGUE_COMMAND_TYPE];
/// Жизненный цикл торговца — только отдельный маршрут администратора.
pub const ADMIN_MERCHANT_LIFECYCLE_COMMANDS: &[&str] = &["CreateMerchant", "ConfigureMerchant", "RestockMerchant", "MoveMerchant", "SetMerchantAvailability"];
/// Переход сцены — только серверный контур Директора.
pub const SERVER_WORLD_COMMANDS: &[&str] = &["AdvanceScene"];
/// Создание столкновения — только `/encounters/assemble`.
pub const SERVER_ENCOUNTER_COMMANDS: &[&str] = &["CreateEncounter"];

// --- приведения JS -------------------------------------------------------------------

/// `value?.[key]` для словаря; у прочих значений собственных полей нет.
pub(crate) fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

/// `object?.[key]` для словаря или массива (индекс): так JS читает
/// `resting[actor]` и `relationships[id]`. Унаследованных ключей нет.
fn lookup<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        Some(Value::Array(items)) if js::is_array_index_key(key) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
        _ => None,
    }
}

/// `a ?? b`.
pub(crate) fn nn<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if js::present(a) {
        a
    } else {
        b
    }
}

/// Список из массива (`x ?? []`); не массив — пусто.
pub(crate) fn list(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `text.length` в единицах UTF-16.
fn len16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, limit)` в единицах UTF-16. Суррогатную пару на границе JS
/// режет пополам (одинокий суррогат); в Rust её половины не бывает — пара
/// отбрасывается целиком.
fn head16(text: &str, limit: usize) -> String {
    let mut used = 0;
    let mut result = String::new();
    for ch in text.chars() {
        used += ch.len_utf16();
        if used > limit {
            break;
        }
        result.push(ch);
    }
    result
}

/// `String(x ?? '').trim().slice(0, limit)`.
fn trimmed(value: Option<&Value>, limit: usize) -> String {
    head16(text::trim(&js::s(value)), limit)
}

/// `String(x ?? '').slice(0, limit)`.
fn sliced(value: Option<&Value>, limit: usize) -> String {
    head16(&js::s(value), limit)
}

/// `String(x ?? fallback)`.
fn s_or(value: Option<&Value>, fallback: &str) -> String {
    if js::present(value) {
        js::s(value)
    } else {
        fallback.to_string()
    }
}

/// `commandPolicyError(message, code)`: ошибка с кодом политики маршрута.
pub fn policy_error(message: impl Into<String>, code: &str) -> Failure {
    Failure::new(message, Some(code))
}

/// `TypeError` V8 на `null.key` (элемент `null` в списке состояния).
fn null_read(key: &str) -> Failure {
    Failure::new(format!("Cannot read properties of null (reading '{key}')"), None)
}

/// `String(candidate.id)` без `?.`: `null` в списке — `TypeError`.
fn strict_id(candidate: &Value) -> GuardResult<String> {
    if candidate.is_null() {
        return Err(null_read("id"));
    }
    Ok(js::string(get(Some(candidate), "id")))
}

/// `(state.players ?? []).some((candidate) => String(candidate.id) === actor)`.
fn party_has(state: &Value, actor: &str) -> GuardResult<bool> {
    for candidate in list(get(Some(state), "players")) {
        if strict_id(candidate)? == actor {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `commandType(command)` (642–644).
pub fn command_type(command: &Value) -> String {
    let source = Some(command);
    js::s(nn(nn(get(source, "command_type"), get(source, "commandType")), get(source, "type")))
}

/// `input?.actor_id ?? input?.actorId` строкой.
fn actor_of(input: &Value) -> String {
    js::s(nn(get(Some(input), "actor_id"), get(Some(input), "actorId")))
}

/// `input?.expected_state_version ?? input?.expectedStateVersion`, если не `null`.
fn expected_version(input: &Value) -> Option<Value> {
    let value = nn(get(Some(input), "expected_state_version"), get(Some(input), "expectedStateVersion"));
    js::present(value).then(|| value.cloned()).flatten()
}

/// Поля `input`, которых нет в белом списке, в порядке `Object.keys`.
fn unexpected_fields(input: &Value, allowed: &[&str]) -> Vec<String> {
    match input {
        Value::Object(map) => js::keys(map).into_iter().filter(|key| !allowed.contains(&key.as_str())).cloned().collect(),
        _ => Vec::new(),
    }
}

/// Отказ за поля вне белого списка: `${prefix}: a, b`.
fn reject_unexpected(input: &Value, allowed: &[&str], prefix: &str, code: &str) -> GuardResult<()> {
    let unexpected = unexpected_fields(input, allowed);
    if unexpected.is_empty() {
        return Ok(());
    }
    Err(policy_error(format!("{prefix}: {}", unexpected.join(", ")), code))
}

/// `{ ...map, request_fingerprint }`.
fn with_fingerprint(mut command: Map<String, Value>, fingerprint: impl FnOnce(&Value) -> String) -> Value {
    let value = Value::Object(command.clone());
    command.insert("request_fingerprint".into(), Value::String(fingerprint(&value)));
    Value::Object(command)
}

fn put(map: &mut Map<String, Value>, key: &str, value: impl Into<Value>) {
    map.insert(key.into(), value.into());
}

fn put_expected(map: &mut Map<String, Value>, input: &Value) {
    if let Some(expected) = expected_version(input) {
        map.insert("expected_state_version".into(), expected);
    }
}

fn put_raw(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

// --- кто действует (510–526) ---------------------------------------------------------

/// Есть ли у кампании записи о членстве (`campaignHasMemberships`).
pub trait Memberships {
    fn campaign_has_memberships(&self, campaign_id: &str) -> GuardResult<bool>;
}

/// Ответ, узнанный заранее (`core::blocking` в маршруте): санитайзеры
/// спрашивают только о кампании своего состояния.
impl Memberships for bool {
    fn campaign_has_memberships(&self, _campaign_id: &str) -> GuardResult<bool> {
        Ok(*self)
    }
}

/// Прямой вопрос хранилищу — только там, где `Accounts` можно звать
/// синхронно (`core::blocking`, тесты).
impl Memberships for sk_store::accounts::Accounts {
    fn campaign_has_memberships(&self, campaign_id: &str) -> GuardResult<bool> {
        Ok(sk_store::accounts::Accounts::campaign_has_memberships(self, campaign_id)?)
    }
}

/// Пользователь запроса и его членство в кампании.
#[derive(Clone, Copy)]
pub struct Caller<'a> {
    pub user: &'a Value,
    pub memberships: &'a dyn Memberships,
}

impl<'a> Caller<'a> {
    pub fn new(user: &'a Value, memberships: &'a dyn Memberships) -> Self {
        Self { user, memberships }
    }

    /// `user.role === 'admin'`.
    pub fn is_admin(&self) -> bool {
        self.user.get("role").and_then(Value::as_str) == Some("admin")
    }

    /// `campaignHeroIds(user, campaignId)` (514–522).
    fn campaign_hero_values(&self, campaign_id: Option<&Value>) -> GuardResult<Vec<Value>> {
        let own = || list(self.user.get("heroIds")).to_vec();
        let code = string_or_empty(campaign_id);
        if text::trim(&code).is_empty() {
            return Ok(own());
        }
        if let Some(membership) = campaign_membership(self.user, &code) {
            return Ok(list(membership.get("heroIds")).to_vec());
        }
        if self.is_admin() {
            return Ok(own());
        }
        Ok(if self.memberships.campaign_has_memberships(&code)? { Vec::new() } else { own() })
    }

    /// `canUseHero(user, heroId, campaignId)` (524–526): `includes` строгий.
    pub fn can_use_hero(&self, hero_id: Option<&Value>, campaign_id: Option<&Value>) -> GuardResult<bool> {
        if self.is_admin() {
            return Ok(true);
        }
        let wanted = Value::String(string_or_empty(hero_id));
        Ok(self.campaign_hero_values(campaign_id)?.contains(&wanted))
    }

    /// `canUseHero(user, actor, state.sessionCode)` для строки героя.
    fn owns(&self, actor: &str, state: &Value) -> GuardResult<bool> {
        self.can_use_hero(Some(&Value::String(actor.to_string())), get(Some(state), "sessionCode"))
    }

    /// `!actor || !canUseHero(...)` — отказ `ACTOR_FORBIDDEN` с текстом маршрута.
    fn require_own(&self, actor: &str, state: &Value, message: &str) -> GuardResult<()> {
        if actor.is_empty() || !self.owns(actor, state)? {
            return Err(policy_error(message, "ACTOR_FORBIDDEN"));
        }
        Ok(())
    }
}

// --- добыча (589–614) ----------------------------------------------------------------

/// `Math.max(0, Number(x) || 0)`.
fn non_negative(value: Option<&Value>) -> Value {
    let number = js::number(value);
    let number = if number.is_nan() || number == 0.0 { 0.0 } else { number };
    js::num(number.max(0.0))
}

/// `lootTakenRecordFor(state, containerId)` (589–608): последняя запись
/// летописи об обыске контейнера — только названные поля.
pub fn loot_taken_record_for(state: &Value, container_id: Option<&Value>) -> Option<Value> {
    let expected = js::s(container_id);
    if expected.is_empty() {
        return None;
    }
    list(get(Some(state), "battleLog")).iter().rev().find_map(|entry| {
        let source = Some(entry);
        if get(source, "type").and_then(Value::as_str) != Some("loot-taken") || js::s(get(source, "containerId")) != expected {
            return None;
        }
        Some(json!({
            "id": js::s(get(source, "id")),
            "type": "loot-taken",
            "actorId": js::s(get(source, "actorId")),
            "recipientId": js::s(get(source, "recipientId")),
            "containerId": expected,
            "containerName": js::s(get(source, "containerName")),
            "itemCount": non_negative(get(source, "itemCount")),
            "remainingCount": non_negative(get(source, "remainingCount")),
            "statusAfter": js::s(get(source, "statusAfter")),
        }))
    })
}

// --- бой (702–826) -------------------------------------------------------------------

/// `authoritativeCombatCommandBase(input)` (702–711).
pub fn authoritative_combat_command_base(input: &Value) -> Value {
    let mut base = Map::new();
    put(&mut base, "command_type", command_type(input));
    put(&mut base, "actor_id", actor_of(input));
    put(&mut base, "server_authoritative", true);
    put_expected(&mut base, input);
    Value::Object(base)
}

/// `String(a ?? b).trim()` при `a == null && b == null` — пусто.
fn either_trimmed(input: &Value, snake: &str, camel: &str) -> Option<String> {
    let source = Some(input);
    let value = nn(get(source, snake), get(source, camel));
    js::present(value).then(|| text::trim(&js::s(value)).to_string())
}

/// `normalizeMakeAttackCommand(input, base)` (713–745). `base` — `None`:
/// база из самого запроса (вызов администратора).
pub fn normalize_make_attack_command(input: &Value, base: Option<Value>) -> GuardResult<Value> {
    let base = base.unwrap_or_else(|| authoritative_combat_command_base(input));
    let source = Some(input);
    let target = js::s(nn(get(source, "target_id"), get(source, "targetId")));
    let item_id = either_trimmed(input, "item_id", "itemId").map(|item| head16(&item, 120)).unwrap_or_default();
    let attack_mode = either_trimmed(input, "attack_mode", "attackMode").map(|mode| text::lower(&mode)).unwrap_or_default();
    let attack_ability = either_trimmed(input, "attack_ability", "attackAbility").map(|ability| text::lower(&ability)).unwrap_or_default();
    let sneak_attack = js::is_true(get(source, "sneak_attack")) || js::is_true(get(source, "sneakAttack"));
    if !attack_mode.is_empty() && !["melee", "ranged", "thrown", "two-handed"].contains(&attack_mode.as_str()) {
        return Err(policy_error("Неизвестный режим атаки оружием", "INVALID_WEAPON_PROFILE"));
    }
    if !attack_ability.is_empty() && !["str", "dex"].contains(&attack_ability.as_str()) {
        return Err(policy_error("Для атаки оружием доступны только Сила или Ловкость", "INVALID_WEAPON_PROFILE"));
    }
    if (!attack_mode.is_empty() || !attack_ability.is_empty() || sneak_attack) && item_id.is_empty() {
        return Err(policy_error("Режим и характеристика выбираются только для конкретного оружия", "INVALID_WEAPON_PROFILE"));
    }
    let mut command = match base {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    put(&mut command, "command_type", "MakeAttack");
    put(&mut command, "target_id", target);
    if !item_id.is_empty() {
        put(&mut command, "item_id", item_id);
    }
    if !attack_mode.is_empty() {
        put(&mut command, "attack_mode", attack_mode);
    }
    if !attack_ability.is_empty() {
        put(&mut command, "attack_ability", attack_ability);
    }
    if sneak_attack {
        put(&mut command, "sneak_attack", true);
    }
    if js::is_true(get(source, "knock_out")) {
        put(&mut command, "knock_out", true);
    }
    Ok(with_fingerprint(command, make_attack_command_fingerprint))
}

/// `assertNpcCombatActorPermission(user, state, input)` (797–806).
pub fn assert_npc_combat_actor_permission(caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<String> {
    let actor = actor_of(input);
    caller.require_own(&actor, state, "Напасть можно только своим героем")?;
    let in_party = list(get(Some(state), "players")).iter().any(|candidate| js::string(get(Some(candidate), "id")) == actor);
    if !in_party {
        return Err(policy_error("Напасть может только герой отряда", "ACTOR_FORBIDDEN"));
    }
    Ok(actor)
}

/// `/^[A-Za-z0-9._:-]+$/u`.
fn is_npc_id(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
}

/// `sanitizePlayerNpcCombatCommand(user, state, input)` (808–824).
pub fn sanitize_player_npc_combat_command(caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<Value> {
    if !PLAYER_NPC_COMBAT_COMMANDS.contains(&command_type(input).as_str()) {
        return Err(policy_error("Игроку доступен только безопасный вход в бой с NPC", "PLAYER_COMMAND_FORBIDDEN"));
    }
    let actor_id = assert_npc_combat_actor_permission(caller, state, input)?;
    let npc_id = trimmed(nn(get(Some(input), "npc_id"), get(Some(input), "npcId")), 120);
    if !is_npc_id(&npc_id) {
        return Err(policy_error("Некорректный npc_id", "NPC_ID_INVALID"));
    }
    let mut command = Map::new();
    put(&mut command, "command_type", "AttackNpc");
    put(&mut command, "actor_id", actor_id.clone());
    put(&mut command, "npc_id", npc_id.clone());
    put(&mut command, "server_authoritative", true);
    put_expected(&mut command, input);
    let fingerprint = sk_rules::combat::encounter::npc_combat_request_fingerprint(&json!({ "actor_id": actor_id, "npc_id": npc_id }));
    put(&mut command, "request_fingerprint", fingerprint);
    Ok(Value::Object(command))
}

/// `combatActorFor(state, actorIdValue)` (1247–1250): герой или актёр
/// кампании; `null` в списке — `TypeError`, как в JS.
pub fn combat_actor_for<'s>(state: &'s Value, actor_id: Option<&Value>) -> GuardResult<Option<&'s Value>> {
    let wanted = js::s(actor_id);
    let source = Some(state);
    for candidate in list(get(source, "players")).iter().chain(list(get(source, "actors"))) {
        if candidate.is_null() {
            return Err(null_read("id"));
        }
        if js::string(nn(get(Some(candidate), "id"), get(Some(candidate), "actor_id"))) == wanted {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// `assertPlayerCombatActorPermission(user, state, input)` (1252–1259):
/// свой герой или призванное существо своего героя.
pub fn assert_player_combat_actor_permission<'s>(caller: &Caller<'_>, state: &'s Value, input: &Value) -> GuardResult<&'s Value> {
    let actor = actor_of(input);
    let actor_value = Value::String(actor.clone());
    let combat_actor = combat_actor_for(state, Some(&actor_value))?;
    let summoned = combat_actor;
    let controller = js::s(nn(nn(nn(get(summoned, "controllerId"), get(summoned, "controller_id")), get(summoned, "ownerId")), get(summoned, "owner_id")));
    let session = get(Some(state), "sessionCode");
    let controls = caller.can_use_hero(Some(&actor_value), session)?
        || (combat_actor.is_some_and(sk_core::game::is_party_summon) && caller.can_use_hero(Some(&Value::String(controller)), session)?);
    if actor.is_empty() || !controls {
        return Err(policy_error("Команда доступна только владельцу героя или его призванного существа", "ACTOR_FORBIDDEN"));
    }
    combat_actor.ok_or_else(|| policy_error("Боевой актёр не найден в кампании", "ACTOR_FORBIDDEN"))
}

/// `{ x: input?.to?.x, y: input?.to?.y }` — поля как есть, `undefined` выпадает.
fn raw_point(to: Option<&Value>) -> Value {
    let mut point = Map::new();
    put_raw(&mut point, "x", get(to, "x"));
    put_raw(&mut point, "y", get(to, "y"));
    Value::Object(point)
}

/// `/^[a-z0-9_:-]{1,120}$/u`.
fn is_casting_resource(text: &str) -> bool {
    (1..=120).contains(&text.chars().count()) && text.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | ':' | '-'))
}

/// `/^[a-z-]{1,40}$/u`.
fn is_form_id(text: &str) -> bool {
    (1..=40).contains(&text.chars().count()) && text.chars().all(|ch| ch.is_ascii_lowercase() || ch == '-')
}

/// `Number.isSafeInteger(x) && x >= low && x <= high` (строго число).
fn safe_int_in(value: Option<&Value>, low: f64, high: f64) -> bool {
    js::is_safe_integer(value) && value.and_then(Value::as_f64).is_some_and(|number| number >= low && number <= high)
}

/// `sanitizePlayerCombatCommand(user, state, input, { skipAttackTargetPolicy })`
/// (1261–1430): из запроса берутся только поля своей команды.
pub fn sanitize_player_combat_command(caller: &Caller<'_>, state: &Value, input: &Value, skip_attack_target_policy: bool) -> GuardResult<Value> {
    let kind = command_type(input);
    if !PLAYER_COMBAT_COMMANDS.contains(&kind.as_str()) {
        return Err(policy_error("Игроку доступен только безопасный набор боевых команд", "PLAYER_COMMAND_FORBIDDEN"));
    }
    assert_player_combat_actor_permission(caller, state, input)?;
    let base = authoritative_combat_command_base(input);
    let mut command = match &base {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let source = Some(input);
    match kind.as_str() {
        "SetSpellBonusPreference" => {
            put(&mut command, "spell_id", js::s(get(source, "spell_id")));
            put_raw(&mut command, "enabled", get(source, "enabled"));
        }
        "SetReactionPreference" => {
            put(&mut command, "reaction_id", sliced(get(source, "reaction_id"), 80));
            put(&mut command, "mode", sliced(get(source, "mode"), 16));
        }
        "MoveActor" => put(&mut command, "to", raw_point(get(source, "to"))),
        "MakeAttack" => {
            let target = js::s(nn(get(source, "target_id"), get(source, "targetId")));
            let mut enemy = false;
            for candidate in list(get(Some(state), "enemies")) {
                if strict_id(candidate)? == target {
                    enemy = true;
                    break;
                }
            }
            let scene_npc = !enemy && list(get(get(Some(state), "social"), "npcs")).iter().any(|candidate| js::s(get(Some(candidate), "id")) == target);
            if !skip_attack_target_policy && !enemy && !scene_npc {
                return Err(policy_error("Цель атаки не найдена", "INVALID_ATTACK_TARGET"));
            }
            return normalize_make_attack_command(input, Some(base));
        }
        "IdentifyEnemy" => put(&mut command, "target_id", sliced(nn(get(source, "target_id"), get(source, "targetId")), 120)),
        "ProposeParley" => {
            let skill = if get(source, "skill").and_then(Value::as_str) == Some("intimidation") { "intimidation" } else { "persuasion" };
            put(&mut command, "skill", skill);
        }
        "SettleParley" => put(&mut command, "outcome", sliced(get(source, "outcome"), 40)),
        "OperateDoor" => {
            let intent = s_or(get(source, "intent"), "open");
            put(&mut command, "door_id", sliced(nn(get(source, "door_id"), get(source, "doorId")), 120));
            put(&mut command, "intent", if ["open", "close", "force"].contains(&intent.as_str()) { intent } else { "open".into() });
        }
        "OperateSceneObject" => {
            let intent = s_or(get(source, "intent"), "inspect");
            put(&mut command, "prop_id", sliced(nn(get(source, "prop_id"), get(source, "propId")), 120));
            put(&mut command, "intent", if ["inspect", "open", "take", "use", "pray"].contains(&intent.as_str()) { intent } else { "inspect".into() });
            put(&mut command, "approach", "hand");
        }
        "UseLevelTransition" => put(&mut command, "prop_id", sliced(nn(get(source, "prop_id"), get(source, "propId")), 120)),
        "MakeAreaAttack" => {
            put(&mut command, "item_id", string_or_empty(get(source, "item_id")));
            put(&mut command, "to", raw_point(get(source, "to")));
        }
        "ChangeWeapon" => put(&mut command, "item_id", string_or_empty(get(source, "item_id"))),
        "CastSpell" => return cast_spell(command, input),
        "UseCombatAction" => return combat_action(command, input),
        "ResolveHeroDeath" => {
            let resolution = sliced(get(source, "resolution"), 20);
            let replace = resolution == "replace";
            put(&mut command, "resolution", resolution);
            if replace {
                put(&mut command, "replacement_name", trimmed(nn(get(source, "replacement_name"), get(source, "replacementName")), 120));
            }
        }
        _ => {}
    }
    Ok(Value::Object(command))
}

/// Ветка `CastSpell` санитайзера боя (1336–1374).
fn cast_spell(mut command: Map<String, Value>, input: &Value) -> GuardResult<Value> {
    let source = Some(input);
    let spell_id = sliced(nn(get(source, "spell_id"), get(source, "spellId")), 120);
    if spell_id.is_empty() {
        return Err(policy_error("Не выбрано заклинание", "SPELL_NOT_AVAILABLE"));
    }
    let target = js::s(nn(get(source, "target_id"), get(source, "targetId")));
    let supplied = nn(get(source, "target_ids"), get(source, "targetIds"));
    let mut targets: Option<Vec<String>> = None;
    if js::present(supplied) {
        let valid = match supplied {
            Some(Value::Array(items)) => {
                !items.is_empty() && items.len() <= 64 && items.iter().all(|id| matches!(id, Value::String(text) if !text::trim(text).is_empty() && len16(text) <= 120))
            }
            _ => false,
        };
        if !valid {
            return Err(policy_error("Нужен непустой список идентификаторов целей заклинания", "INVALID_SPELL_TARGETS"));
        }
        let mut unique: Vec<String> = Vec::new();
        for id in list(supplied) {
            let id = text::trim(id.as_str().unwrap_or_default()).to_string();
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        if ["longstrider", "chain-lightning"].contains(&spell_id.as_str()) && unique.len() != list(supplied).len() {
            return Err(policy_error("Выберите каждую цель только один раз", "INVALID_SPELL_TARGETS"));
        }
        targets = Some(unique);
    }
    let casting_resource = get(source, "casting_resource");
    if js::present(casting_resource) && !casting_resource.and_then(Value::as_str).is_some_and(is_casting_resource) {
        return Err(policy_error("Неверный источник применения заклинания", "INVALID_CASTING_RESOURCE"));
    }
    let spell_option = nn(get(source, "spell_option"), get(source, "spellOption"));
    if js::present(spell_option) && !spell_option.and_then(Value::as_str).is_some_and(|option| len16(option) <= 120) {
        return Err(policy_error("Неверный вариант заклинания", "INVALID_SPELL_OPTION"));
    }
    let slot_level = nn(get(source, "slot_level"), get(source, "slotLevel"));
    if js::present(slot_level) && !safe_int_in(slot_level, 1.0, 9.0) {
        return Err(policy_error("Неверный уровень ячейки", "INVALID_SPELL_SLOT_LEVEL"));
    }
    put(&mut command, "spell_id", spell_id);
    if let Some(targets) = targets {
        put(&mut command, "target_ids", js::strings_value(targets));
    } else if !target.is_empty() {
        put(&mut command, "target_id", target);
    }
    if js::truthy(spell_option) {
        put_raw(&mut command, "spell_option", spell_option);
    }
    if js::present(slot_level) {
        put_raw(&mut command, "slot_level", slot_level);
    }
    if js::present(casting_resource) {
        put_raw(&mut command, "casting_resource", casting_resource);
    }
    if js::present(get(source, "item_id")) || js::present(get(source, "itemId")) {
        put(&mut command, "item_id", trimmed(nn(get(source, "item_id"), get(source, "itemId")), 120));
    }
    let to = get(source, "to");
    if js::truthy(to) {
        put(&mut command, "to", raw_point(to));
    }
    if js::is_true(get(source, "knock_out")) {
        put(&mut command, "knock_out", true);
    }
    Ok(Value::Object(command))
}

/// Ветка `UseCombatAction` санитайзера боя (1375–1402).
fn combat_action(mut command: Map<String, Value>, input: &Value) -> GuardResult<Value> {
    let source = Some(input);
    let action_id = sliced(nn(get(source, "action_id"), get(source, "actionId")), 120);
    if action_id.is_empty() {
        return Err(policy_error("Не выбрано боевое действие", "COMBAT_ACTION_NOT_AVAILABLE"));
    }
    let target = sliced(nn(get(source, "target_id"), get(source, "targetId")), 120);
    let beneficiary = nn(get(source, "beneficiary_id"), get(source, "beneficiaryId"));
    if js::present(beneficiary) && !beneficiary.and_then(Value::as_str).is_some_and(|text| !text::trim(text).is_empty() && len16(text) <= 120) {
        return Err(policy_error("Неверный получатель бонуса реакции", "INVALID_REACTION_BENEFICIARY"));
    }
    let action = action_id.as_str();
    put(&mut command, "action_id", action_id.clone());
    if !target.is_empty() {
        put(&mut command, "target_id", target);
    }
    if action == "cast:silvery-barbs" {
        if let Some(Value::String(beneficiary)) = beneficiary {
            put(&mut command, "beneficiary_id", text::trim(beneficiary));
        }
    }
    let item_id = get(source, "item_id");
    if js::truthy(item_id) {
        put(&mut command, "item_id", sliced(item_id, 120));
    }
    let shove_mode = get(source, "shove_mode");
    if action == "shove" && js::present(shove_mode) {
        put(&mut command, "shove_mode", sliced(shove_mode, 20));
    }
    let slot_level = get(source, "slot_level");
    if (action == "divine-smite" || action == "font-of-magic") && safe_int_in(slot_level, 1.0, 5.0) {
        put_raw(&mut command, "slot_level", slot_level);
    }
    let font_mode = get(source, "font_mode").and_then(Value::as_str);
    if action == "font-of-magic" && matches!(font_mode, Some("create" | "convert")) {
        put_raw(&mut command, "font_mode", get(source, "font_mode"));
    }
    let amount = get(source, "amount");
    if action == "lay-on-hands" && safe_int_in(amount, 1.0, 200.0) {
        put_raw(&mut command, "amount", amount);
    }
    let form_id = get(source, "form_id");
    if action == "wild-shape" && form_id.and_then(Value::as_str).is_some_and(is_form_id) {
        put_raw(&mut command, "form_id", form_id);
    }
    Ok(Value::Object(command))
}

// --- отдых и развитие (1432–1546) ----------------------------------------------------

const BASE_FIELDS: &[&str] = &["command_type", "commandType", "type", "actor_id", "actorId", "expected_state_version", "expectedStateVersion"];

/// Белый список: общие поля и поля команды.
fn allowed_with(extra: &[&'static str]) -> Vec<&'static str> {
    BASE_FIELDS.iter().copied().chain(extra.iter().copied()).collect()
}

/// `sanitizePlayerRestCommand(user, state, input)` (1432–1469).
pub fn sanitize_player_rest_command(caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<Value> {
    let kind = command_type(input);
    if !PLAYER_REST_COMMANDS.contains(&kind.as_str()) {
        return Err(policy_error("Команда не относится к отдыху", "PLAYER_COMMAND_FORBIDDEN"));
    }
    let start = kind == "StartRest";
    let allowed = allowed_with(if start { &["kind"] } else { &[] });
    reject_unexpected(input, &allowed, "Команда отдыха содержит запрещённые поля", "REST_COMMAND_UNKNOWN_FIELD")?;
    let rest_kind = get(Some(input), "kind");
    if start && rest_kind.is_some() && !matches!(rest_kind.and_then(Value::as_str), Some("short" | "long")) {
        return Err(policy_error("Вид отдыха должен быть short или long", "REST_KIND_INVALID"));
    }
    let actor = actor_of(input);
    caller.require_own(&actor, state, "Отдыхать можно только от имени своего героя")?;
    if !party_has(state, &actor)? {
        return Err(policy_error("Герой не найден в кампании", "ACTOR_FORBIDDEN"));
    }
    let mut command = Map::new();
    put(&mut command, "command_type", kind.clone());
    put(&mut command, "actor_id", actor.clone());
    if start {
        put(&mut command, "kind", if rest_kind.and_then(Value::as_str) == Some("long") { "long" } else { "short" });
    } else {
        let rest_id = get(lookup(get(get(Some(state), "mechanics"), "resting"), &actor), "rest_id");
        if js::truthy(rest_id) {
            put(&mut command, "rest_id", js::string(rest_id));
        }
    }
    put_expected(&mut command, input);
    put(&mut command, "server_authoritative", true);
    Ok(with_fingerprint(command, rest_command_fingerprint))
}

/// `expandPlayerRestCommand(command)` (1471–1492): короткий отдых — час
/// мирового времени, долгий — восемь часов и завершение.
pub fn expand_player_rest_command(command: &Value) -> Vec<Value> {
    if command_type(command) != "StartRest" {
        return vec![command.clone()];
    }
    let long = get(Some(command), "kind").and_then(Value::as_str) == Some("long");
    let fingerprint = get(Some(command), "request_fingerprint");
    let mut advance = Map::new();
    put(&mut advance, "command_type", "AdvanceTime");
    put(&mut advance, "amount", if long { 480 } else { 60 });
    put(&mut advance, "unit", "minute");
    put(&mut advance, "server_authoritative", true);
    put_raw(&mut advance, "request_fingerprint", fingerprint);
    let mut commands = vec![command.clone(), Value::Object(advance)];
    if long {
        let mut complete = Map::new();
        put(&mut complete, "command_type", "CompleteRest");
        put_raw(&mut complete, "actor_id", get(Some(command), "actor_id"));
        put(&mut complete, "kind", "long");
        put(&mut complete, "server_authoritative", true);
        put_raw(&mut complete, "request_fingerprint", fingerprint);
        commands.push(Value::Object(complete));
    }
    commands
}

/// `Array.isArray(a ?? b) ? (a ?? b).map(String) : []`.
fn string_list(input: &Value, snake: &str, camel: &str) -> Value {
    match nn(get(Some(input), snake), get(Some(input), camel)) {
        Some(Value::Array(items)) => js::strings_value(items.iter().map(|item| js::string(Some(item)))),
        _ => Value::Array(Vec::new()),
    }
}

/// `sanitizePlayerCharacterCommand(user, state, input)` (1494–1563).
pub fn sanitize_player_character_command(caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<Value> {
    let kind = command_type(input);
    if !PLAYER_CHARACTER_COMMANDS.contains(&kind.as_str()) && !PLAYER_CHARACTER_LIFECYCLE_COMMANDS.contains(&kind.as_str()) {
        return Err(policy_error("Команда не относится к развитию персонажа", "PLAYER_COMMAND_FORBIDDEN"));
    }
    let actor = actor_of(input);
    caller.require_own(&actor, state, "Изменять развитие можно только у своего героя")?;
    if !party_has(state, &actor)? {
        return Err(policy_error("Герой не найден в кампании", "ACTOR_FORBIDDEN"));
    }
    let source = Some(input);
    let mut command = Map::new();
    put(&mut command, "command_type", kind.clone());
    put(&mut command, "actor_id", actor);
    put_expected(&mut command, input);
    match kind.as_str() {
        "LevelUp" => {
            let level = nn(get(source, "expected_level"), get(source, "expectedLevel"));
            if js::present(level) {
                put_raw(&mut command, "expected_level", level);
            }
            return Ok(Value::Object(command));
        }
        "ImportCharacter" => {
            put_raw(&mut command, "document", get(source, "document"));
            return Ok(Value::Object(command));
        }
        "RollCharacterAbilities" => {
            put_raw(&mut command, "roll_index", get(source, "roll_index"));
            return Ok(Value::Object(command));
        }
        "RollCharacterWealth" => {
            put(&mut command, "character_class", js::s(get(source, "character_class")));
            return Ok(Value::Object(command));
        }
        _ => {}
    }
    if kind == "SetCharacterChoices" {
        put(&mut command, "subclass", trimmed(get(source, "subclass"), 160));
        put(&mut command, "class_skill_proficiencies", string_list(input, "class_skill_proficiencies", "classSkillProficiencies"));
        put(&mut command, "selected_feature_ids", string_list(input, "selected_feature_ids", "selectedFeatureIds"));
        let level = nn(get(source, "ability_score_level"), get(source, "abilityScoreLevel"));
        if js::present(level) {
            put_raw(&mut command, "ability_score_level", level);
        }
        if js::present(nn(get(source, "ability_score_increases"), get(source, "abilityScoreIncreases"))) {
            put(&mut command, "ability_score_increases", string_list(input, "ability_score_increases", "abilityScoreIncreases"));
        }
        let feat = nn(get(source, "ability_score_feat"), get(source, "abilityScoreFeat"));
        if js::present(feat) {
            let mut chosen = Map::new();
            put(&mut chosen, "id", js::s(get(feat, "id")));
            put_raw(&mut chosen, "choices", get(feat, "choices"));
            put(&mut command, "ability_score_feat", Value::Object(chosen));
        }
    } else {
        put(&mut command, "known_spell_ids", string_list(input, "known_spell_ids", "knownSpellIds"));
        put(&mut command, "prepared_spell_ids", string_list(input, "prepared_spell_ids", "preparedSpellIds"));
    }
    Ok(with_fingerprint(command, character_build_fingerprint))
}

// --- общество: кража, пленный, обыск, зверь, стража, таверна, благословение,
// разговор, письмо (1565–1957) -------------------------------------------------------

/// Общая форма простого санитайзера: тип, белый список, свой герой.
struct Simple<'a> {
    set: &'a [&'a str],
    forbidden: &'a str,
    fields: &'a [&'static str],
    unknown_prefix: &'a str,
    unknown_code: &'a str,
    actor_message: &'a str,
}

/// Проверки простого санитайзера; итог — тип команды и герой.
fn simple_checks(spec: &Simple<'_>, caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<(String, String)> {
    let kind = command_type(input);
    if !spec.set.contains(&kind.as_str()) {
        return Err(policy_error(spec.forbidden, "PLAYER_COMMAND_FORBIDDEN"));
    }
    reject_unexpected(input, &allowed_with(spec.fields), spec.unknown_prefix, spec.unknown_code)?;
    let actor = actor_of(input);
    caller.require_own(&actor, state, spec.actor_message)?;
    Ok((kind, actor))
}

/// `{ command_type, actor_id }`.
fn head_of(kind: String, actor: String) -> Map<String, Value> {
    let mut command = Map::new();
    put(&mut command, "command_type", kind);
    put(&mut command, "actor_id", actor);
    command
}

/// `sanitizePlayerPickpocketCommand(user, state, input)` (1573–1597).
pub fn sanitize_player_pickpocket_command(caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<Value> {
    let spec = Simple {
        set: PLAYER_PICKPOCKET_COMMANDS,
        forbidden: "Команда не относится к карманной краже",
        fields: &["npc_id", "npcId"],
        unknown_prefix: "Команда кражи содержит запрещённые поля",
        unknown_code: "PICKPOCKET_COMMAND_UNKNOWN_FIELD",
        actor_message: "Обчистить карман можно только своим героем",
    };
    let (kind, actor) = simple_checks(&spec, caller, state, input)?;
    let npc_id = trimmed(nn(get(Some(input), "npc_id"), get(Some(input), "npcId")), 120);
    if npc_id.is_empty() {
        return Err(policy_error("Не выбран человек", "NPC_NOT_FOUND"));
    }
    let mut command = head_of(kind, actor);
    put(&mut command, "npc_id", npc_id);
    put(&mut command, "server_authoritative", true);
    put_expected(&mut command, input);
    Ok(Value::Object(command))
}

/// `sanitizePlayerCaptiveCommand(user, state, input)` (1580–1611).
pub fn sanitize_player_captive_command(caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<Value> {
    let spec = Simple {
        set: PLAYER_CAPTIVE_COMMANDS,
        forbidden: "Команда не относится к действиям с пленным",
        fields: &["captive_id", "captiveId", "skill"],
        unknown_prefix: "Команда пленного содержит запрещённые поля",
        unknown_code: "CAPTIVE_COMMAND_UNKNOWN_FIELD",
        actor_message: "Распорядиться пленным можно только от имени своего героя",
    };
    let (kind, actor) = simple_checks(&spec, caller, state, input)?;
    let captive_id = trimmed(nn(get(Some(input), "captive_id"), get(Some(input), "captiveId")), 120);
    if captive_id.is_empty() {
        return Err(policy_error("Не выбран пленный", "CAPTIVE_NOT_FOUND"));
    }
    let interrogate = kind == "InterrogateCaptive";
    let mut command = head_of(kind, actor);
    put(&mut command, "captive_id", captive_id);
    put(&mut command, "server_authoritative", true);
    if interrogate {
        put(&mut command, "skill", s_or(get(Some(input), "skill"), "intimidation"));
    }
    put_expected(&mut command, input);
    Ok(Value::Object(command))
}

/// `sanitizePlayerLootCommand(user, state, input)` (1622–1675): из запроса —
/// только контейнер, экземпляры и количества.
pub fn sanitize_player_loot_command(caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<Value> {
    let spec = Simple {
        set: PLAYER_LOOT_COMMANDS,
        forbidden: "Команда не относится к обыску добычи",
        fields: &["container_id", "containerId", "recipient_id", "recipientId", "lines"],
        unknown_prefix: "Команда обыска содержит запрещённые поля",
        unknown_code: "LOOT_COMMAND_UNKNOWN_FIELD",
        actor_message: "Обыскивать можно только своим героем",
    };
    let (kind, actor) = simple_checks(&spec, caller, state, input)?;
    let source = Some(input);
    let container_id = trimmed(nn(get(source, "container_id"), get(source, "containerId")), 120);
    if container_id.is_empty() {
        return Err(policy_error("Не выбран контейнер добычи", "LOOT_CONTAINER_NOT_FOUND"));
    }
    let requested = match get(source, "lines") {
        Some(Value::Array(items)) if !items.is_empty() => items,
        _ => return Err(policy_error("Не выбрано ни одного предмета", "LOOT_LINES_REQUIRED")),
    };
    let mut lines = Vec::new();
    for line in requested.iter().take(sets::MAX_LOOT_LINES) {
        let Value::Object(fields) = line else {
            return Err(policy_error("Строка обыска содержит запрещённые поля", "LOOT_COMMAND_UNKNOWN_FIELD"));
        };
        if fields.keys().any(|key| !["item_instance_id", "itemInstanceId", "quantity"].contains(&key.as_str())) {
            return Err(policy_error("Строка обыска содержит запрещённые поля", "LOOT_COMMAND_UNKNOWN_FIELD"));
        }
        let item_instance_id = trimmed(nn(fields.get("item_instance_id"), fields.get("itemInstanceId")), 160);
        if item_instance_id.is_empty() {
            return Err(policy_error("В строке обыска нет предмета", "LOOT_LINES_REQUIRED"));
        }
        let quantity_field = fields.get("quantity");
        let quantity = if js::present(quantity_field) { js::number(quantity_field) } else { 1.0 };
        if !(quantity.is_finite() && quantity.fract() == 0.0 && quantity.abs() <= 9_007_199_254_740_991.0) || quantity < 1.0 {
            return Err(policy_error("Недопустимое количество предметов", "LOOT_QUANTITY_INVALID"));
        }
        lines.push(json!({ "item_instance_id": item_instance_id, "quantity": js::num(quantity) }));
    }
    let recipient_id = trimmed(nn(get(source, "recipient_id"), get(source, "recipientId")), 120);
    let recipient = if recipient_id.is_empty() { actor.clone() } else { recipient_id };
    let mut command = head_of(kind, actor);
    put(&mut command, "container_id", container_id);
    put(&mut command, "recipient_id", recipient);
    put(&mut command, "lines", Value::Array(lines));
    put(&mut command, "server_authoritative", true);
    put_expected(&mut command, input);
    Ok(with_fingerprint(command, loot_command_fingerprint))
}

/// `sanitizePlayerBeastCommand(user, state, input)` (1683–1711).
pub fn sanitize_player_beast_command(caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<Value> {
    let spec = Simple {
        set: PLAYER_BEAST_COMMANDS,
        forbidden: "Команда не относится к действиям со зверем",
        fields: &["beast_id", "beastId"],
        unknown_prefix: "Команда зверя содержит запрещённые поля",
        unknown_code: "BEAST_COMMAND_UNKNOWN_FIELD",
        actor_message: "Подойти к зверю можно только от имени своего героя",
    };
    let (kind, actor) = simple_checks(&spec, caller, state, input)?;
    let beast_id = trimmed(nn(get(Some(input), "beast_id"), get(Some(input), "beastId")), 120);
    if beast_id.is_empty() {
        return Err(policy_error("Не выбран зверь", "BEAST_NOT_FOUND"));
    }
    let mut command = head_of(kind, actor);
    put(&mut command, "beast_id", beast_id);
    put(&mut command, "server_authoritative", true);
    put_expected(&mut command, input);
    Ok(Value::Object(command))
}

/// `sanitizePlayerLawCommand(user, state, input)` (1718–1745).
pub fn sanitize_player_law_command(caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<Value> {
    let spec = Simple {
        set: PLAYER_LAW_COMMANDS,
        forbidden: "Команда не относится к встрече со стражей",
        fields: &["resolution", "skill"],
        unknown_prefix: "Ответ страже содержит запрещённые поля",
        unknown_code: "LAW_COMMAND_UNKNOWN_FIELD",
        actor_message: "Отвечать страже можно только от имени своего героя",
    };
    let (kind, actor) = simple_checks(&spec, caller, state, input)?;
    let source = Some(input);
    let mut command = head_of(kind, actor);
    put(&mut command, "resolution", sliced(get(source, "resolution"), 30));
    put(&mut command, "skill", if get(source, "skill").and_then(Value::as_str) == Some("athletics") { "athletics" } else { "stealth" });
    put(&mut command, "server_authoritative", true);
    put_expected(&mut command, input);
    Ok(Value::Object(command))
}

/// `sanitizePlayerTavernCommand(user, state, input)` (1753–1790).
pub fn sanitize_player_tavern_command(caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<Value> {
    let spec = Simple {
        set: PLAYER_TAVERN_COMMANDS,
        forbidden: "Команда не относится к досугу таверны",
        fields: &["npc_id", "npcId", "stake_cp", "stakeCp", "approach"],
        unknown_prefix: "Команда таверны содержит запрещённые поля",
        unknown_code: "TAVERN_COMMAND_UNKNOWN_FIELD",
        actor_message: "Сесть за стол можно только своим героем",
    };
    let (kind, actor) = simple_checks(&spec, caller, state, input)?;
    let source = Some(input);
    let stake = js::number(nn(get(source, "stake_cp"), get(source, "stakeCp")));
    let open = kind == "OpenTavernDiceRound";
    let answer = kind == "AnswerTavernDiceRound";
    let mut command = head_of(kind, actor);
    if open {
        put(&mut command, "npc_id", trimmed(nn(get(source, "npc_id"), get(source, "npcId")), 120));
        let known = sets::TAVERN_STAKES_CP.iter().any(|known| *known as f64 == stake);
        put(&mut command, "stake_cp", if known { js::num(stake) } else { Value::from(0) });
    }
    if answer {
        let approach = js::string(get(source, "approach"));
        put(&mut command, "approach", if sets::TAVERN_DICE_APPROACHES.contains(&approach.as_str()) { approach } else { "fair".into() });
    }
    put(&mut command, "server_authoritative", true);
    put_expected(&mut command, input);
    Ok(Value::Object(command))
}

/// `sanitizePlayerBlessingCommand(user, state, input)` (1797–1822).
pub fn sanitize_player_blessing_command(caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<Value> {
    let spec = Simple {
        set: PLAYER_BLESSING_COMMANDS,
        forbidden: "Команда не относится к благословениям",
        fields: &["npc_id", "npcId"],
        unknown_prefix: "Просьба о благословении содержит запрещённые поля",
        unknown_code: "BLESSING_COMMAND_UNKNOWN_FIELD",
        actor_message: "Благословение принимают только своим героем",
    };
    let (kind, actor) = simple_checks(&spec, caller, state, input)?;
    let mut command = head_of(kind, actor);
    put(&mut command, "npc_id", trimmed(nn(get(Some(input), "npc_id"), get(Some(input), "npcId")), 120));
    put(&mut command, "server_authoritative", true);
    put_expected(&mut command, input);
    Ok(Value::Object(command))
}

/// `sanitizePlayerDialogueCommand(user, state, input)` (1824–1851).
pub fn sanitize_player_dialogue_command(caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<Value> {
    let spec = Simple {
        set: PLAYER_DIALOGUE_COMMANDS,
        forbidden: "Команда не относится к разговору",
        fields: &["npc_id", "npcId", "option_id", "optionId"],
        unknown_prefix: "Выбор в разговоре содержит запрещённые поля",
        unknown_code: "DIALOGUE_COMMAND_UNKNOWN_FIELD",
        actor_message: "Говорят только своим героем",
    };
    let (kind, actor) = simple_checks(&spec, caller, state, input)?;
    let source = Some(input);
    let mut command = head_of(kind, actor);
    put(&mut command, "npc_id", trimmed(nn(get(source, "npc_id"), get(source, "npcId")), 120));
    put(&mut command, "option_id", trimmed(nn(get(source, "option_id"), get(source, "optionId")), 80));
    put(&mut command, "server_authoritative", true);
    put_expected(&mut command, input);
    Ok(Value::Object(command))
}

/// `sanitizePlayerLetterCommand(user, state, input)` (1865–1898).
/// `reply_draft` в белый список не входит: черновик ответа ставит только
/// сервер ([`with_courier_reply_draft`]).
pub fn sanitize_player_letter_command(caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<Value> {
    let spec = Simple {
        set: PLAYER_LETTER_COMMANDS,
        forbidden: "Команда не относится к почте отряда",
        fields: &["addressee_kind", "addresseeKind", "addressee_id", "addresseeId", "body"],
        unknown_prefix: "Команда письма содержит запрещённые поля",
        unknown_code: "COURIER_COMMAND_UNKNOWN_FIELD",
        actor_message: "Письмо можно написать только своим героем",
    };
    let (kind, actor) = simple_checks(&spec, caller, state, input)?;
    let source = Some(input);
    let addressee_kind = s_or(nn(get(source, "addressee_kind"), get(source, "addresseeKind")), "npc");
    let mut command = head_of(kind, actor);
    let known = sets::COURIER_LETTER_ADDRESSEE_KINDS.contains(&addressee_kind.as_str());
    put(&mut command, "addressee_kind", if known { addressee_kind } else { "npc".into() });
    put(&mut command, "addressee_id", trimmed(nn(get(source, "addressee_id"), get(source, "addresseeId")), 120));
    put(&mut command, "body", sliced(get(source, "body"), sets::COURIER_LETTER_BODY_LIMIT));
    put(&mut command, "server_authoritative", true);
    put_expected(&mut command, input);
    Ok(Value::Object(command))
}

// --- черновик ответа на письмо (1900–1955) -------------------------------------------

/// Будущее ответа модели (ядро однопоточное, `Send` не нужен).
pub type ReplyFuture<'a> = Pin<Box<dyn Future<Output = Result<Option<Value>, String>> + 'a>>;

/// Социальный движок для полировки ответа на письмо (`npcSocialController`).
pub trait CourierReplyModel {
    /// `npcSocialController.llmClient`: есть ли модель вообще.
    fn has_model(&self) -> bool;
    /// `npcSocialController.respond({ state, playerId, npcId, message, turnId })`:
    /// реплика (`{ reply, provider, … }`), `None` — NPC недоступен, `Err` —
    /// исключение (письмо уходит с детерминированной основой).
    fn respond<'a>(&'a self, input: Value) -> ReplyFuture<'a>;
}

/// [`CourierReplyModel`] поверх `NpcSocialController`; есть ли у него
/// клиент модели, знает тот, кто его собирал.
pub struct SocialCourierModel<'a> {
    pub controller: &'a sk_agents::npc_social_controller::NpcSocialController,
    pub has_model: bool,
}

impl CourierReplyModel for SocialCourierModel<'_> {
    fn has_model(&self) -> bool {
        self.has_model
    }

    fn respond<'a>(&'a self, input: Value) -> ReplyFuture<'a> {
        Box::pin(async move { self.controller.respond(&input).await.map_err(|error| format!("{error:?}")) })
    }
}

/// `withCourierReplyDraft(state, command)` (1918–1955): ответ NPC пишется
/// при отправке и запечатывается в письмо вместе с тоном. Модели нет, она
/// ошиблась или ответила своим фолбэком — команда уходит как была.
pub async fn with_courier_reply_draft(model: &dyn CourierReplyModel, state: &Value, command: Value) -> Value {
    let source = Some(&command);
    let addressee = sets::courier_addressee_for(state, get(source, "addressee_kind"), get(source, "addressee_id"), None);
    let Some(addressee) = addressee else { return command };
    if get(Some(&addressee), "kind").and_then(Value::as_str) != Some("npc") || !model.has_model() {
        return command;
    }
    let addressee_id = get(Some(&addressee), "id");
    let relationships = get(get(Some(state), "social"), "relationships");
    let score = lookup(lookup(relationships, &js::string(addressee_id)), &js::string(get(source, "actor_id")));
    let score = if js::present(score) { score.cloned() } else { Some(Value::from(0)) };
    let tone = sets::courier_tone_for(score.as_ref());
    if tone == "silent" {
        return command;
    }
    let promise = sets::courier_letter_promise_from(get(source, "body"));
    let promise_text = promise.as_ref().map(|promise| format!(" [в письме дано слово: {}]", js::string(get(Some(promise), "text")))).unwrap_or_default();
    let mut input = Map::new();
    put(&mut input, "state", state.clone());
    put_raw(&mut input, "playerId", get(source, "actor_id"));
    put_raw(&mut input, "npcId", addressee_id);
    put(&mut input, "message", format!("[письмо, доставлено курьером] {}{promise_text}", js::string(get(source, "body"))));
    put(&mut input, "turnId", format!("letter:{}", js::s(get(source, "command_id"))));
    let Ok(result) = model.respond(Value::Object(input)).await else { return command };
    let result = result.as_ref();
    let provider = sliced(get(result, "provider"), 80);
    let reply = head16(&text::squash_spaces(&js::s(get(result, "reply"))), 1_000);
    if reply.is_empty() || provider == "deterministic-social-fallback" {
        return command;
    }
    let mut drafted = match command {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    put(&mut drafted, "reply_draft", reply);
    put(&mut drafted, "reply_draft_tone", tone);
    put(&mut drafted, "reply_provider", if provider.is_empty() { "llm".to_string() } else { provider });
    Value::Object(drafted)
}

// --- предметы и торговля (1957–2069) -------------------------------------------------

/// `sanitizePlayerItemCommand(user, state, input)` (1957–2034).
pub fn sanitize_player_item_command(caller: &Caller<'_>, state: &Value, input: &Value) -> GuardResult<Value> {
    let kind = command_type(input);
    if !PLAYER_ITEM_COMMANDS.contains(&kind.as_str()) {
        return Err(policy_error("Команда не относится к действиям с предметами", "PLAYER_COMMAND_FORBIDDEN"));
    }
    let allowed = allowed_with(&[
        "item_id", "itemId", "target_id", "targetId", "recipient_id", "recipientId", "quantity", "equipped", "attuned", "activated", "charges_to_spend", "chargesToSpend", "to", "use_mode", "useMode", "weapon_id",
        "weaponId",
    ]);
    reject_unexpected(input, &allowed, "Команда предмета содержит запрещённые поля", "ITEM_COMMAND_UNKNOWN_FIELD")?;
    let actor = actor_of(input);
    caller.require_own(&actor, state, "Действовать с предметами можно только от имени своего героя")?;
    if !party_has(state, &actor)? {
        return Err(policy_error("Герой не найден в кампании", "ACTOR_FORBIDDEN"));
    }
    let source = Some(input);
    let item_id = trimmed(nn(get(source, "item_id"), get(source, "itemId")), 120);
    if item_id.is_empty() {
        return Err(policy_error("Предмет не найден у героя", "ITEM_NOT_FOUND"));
    }
    let mut command = Map::new();
    put(&mut command, "command_type", kind.clone());
    put(&mut command, "actor_id", actor.clone());
    put(&mut command, "item_id", item_id);
    put_expected(&mut command, input);
    match kind.as_str() {
        "EquipItem" => {
            put(&mut command, "equipped", !js::is_false(get(source, "equipped")));
            if get(source, "equip_slot").and_then(Value::as_str) == Some("off_hand") {
                put(&mut command, "equip_slot", "off_hand");
            }
        }
        "AttuneItem" => put(&mut command, "attuned", !js::is_false(get(source, "attuned"))),
        "ActivateItem" => {
            let Some(Value::Bool(activated)) = get(source, "activated") else {
                return Err(policy_error("Нужно явно выбрать включение или выключение предмета", "INVALID_ITEM_ACTIVATION"));
            };
            put(&mut command, "activated", *activated);
            put(&mut command, "server_authoritative", true);
        }
        "UseItem" => use_item(&mut command, input, &actor)?,
        _ => {
            let recipient = nn(nn(nn(get(source, "recipient_id"), get(source, "recipientId")), get(source, "target_id")), get(source, "targetId"));
            put(&mut command, "recipient_id", trimmed(recipient, 120));
            let quantity = get(source, "quantity");
            put(&mut command, "quantity", if js::present(quantity) { js::num(js::number(quantity)) } else { Value::from(1) });
        }
    }
    Ok(with_fingerprint(command, item_command_fingerprint))
}

/// Ветка `UseItem` санитайзера предмета (1999–2025).
fn use_item(command: &mut Map<String, Value>, input: &Value, actor: &str) -> GuardResult<()> {
    let source = Some(input);
    let actor_value = Value::String(actor.to_string());
    let target_id = trimmed(nn(nn(get(source, "target_id"), get(source, "targetId")), Some(&actor_value)), 120);
    let charges = nn(get(source, "charges_to_spend"), get(source, "chargesToSpend"));
    let requested_point = get(source, "to");
    let mut point = None;
    if js::present(requested_point) {
        let valid = match requested_point {
            Some(Value::Object(fields)) => fields.keys().all(|key| key == "x" || key == "y") && js::is_safe_integer_number(fields.get("x")) && js::is_safe_integer_number(fields.get("y")),
            _ => false,
        };
        if !valid {
            return Err(policy_error("Клетка применения предмета должна содержать только целые координаты x и y", "INVALID_ITEM_POINT"));
        }
        point = Some(json!({ "x": js::num(js::number(get(requested_point, "x"))), "y": js::num(js::number(get(requested_point, "y"))) }));
    }
    let mode = text::trim(&js::s(nn(get(source, "use_mode"), get(source, "useMode")))).to_string();
    if !mode.is_empty() && mode != "spill" {
        return Err(policy_error("Неизвестный режим применения предмета", "INVALID_ITEM_USE_MODE"));
    }
    let weapon_id = trimmed(nn(get(source, "weapon_id"), get(source, "weaponId")), 120);
    put(command, "target_id", if target_id.is_empty() { actor.to_string() } else { target_id });
    if js::present(charges) {
        put(command, "charges_to_spend", js::num(js::number(charges)));
    }
    if let Some(point) = point {
        put(command, "to", point);
    }
    if !mode.is_empty() {
        put(command, "use_mode", mode);
    }
    if !weapon_id.is_empty() {
        put(command, "weapon_id", weapon_id);
    }
    put(command, "server_authoritative", true);
    Ok(())
}

/// `sanitizeMerchantCommand(user, state, input, routeMerchantId)` (2036–2069):
/// торговля игрока; `route_merchant_id` — id из пути `merchants/:id/commands`.
pub fn sanitize_merchant_command(caller: &Caller<'_>, state: &Value, input: &Value, route_merchant_id: Option<&Value>) -> GuardResult<Value> {
    let kind = command_type(input);
    if !PLAYER_MERCHANT_COMMANDS.contains(&kind.as_str()) {
        return Err(policy_error("Для торговца доступна только оценка, покупка, продажа или попытка договориться о цене", "PLAYER_COMMAND_FORBIDDEN"));
    }
    let actor = actor_of(input);
    caller.require_own(&actor, state, "Торговать можно только от имени своего героя")?;
    if !party_has(state, &actor)? {
        return Err(policy_error("Герой не найден в кампании", "ACTOR_FORBIDDEN"));
    }
    let source = Some(input);
    let merchant_id = sliced(nn(nn(route_merchant_id, get(source, "merchant_id")), get(source, "merchantId")), 120);
    if merchant_id.is_empty() {
        return Err(policy_error("Не указан торговец", "MERCHANT_NOT_FOUND"));
    }
    let expected = js::number(nn(get(source, "expected_state_version"), get(source, "expectedStateVersion")));
    if !(expected.is_finite() && expected.fract() == 0.0 && expected.abs() <= 9_007_199_254_740_991.0) || expected < 0.0 {
        return Err(policy_error("Перед сделкой нужно получить актуальные котировки", "EXPECTED_STATE_VERSION_REQUIRED"));
    }
    let mut command = Map::new();
    put(&mut command, "command_type", kind.clone());
    put(&mut command, "actor_id", actor);
    put(&mut command, "merchant_id", merchant_id);
    put(&mut command, "expected_state_version", js::num(expected));
    match kind.as_str() {
        "BuyItem" => {
            put(&mut command, "stock_id", sliced(nn(get(source, "stock_id"), get(source, "stockId")), 120));
            put_raw(&mut command, "quantity", get(source, "quantity"));
        }
        "SellItem" => {
            put(&mut command, "item_id", sliced(nn(get(source, "item_id"), get(source, "itemId")), 120));
            put_raw(&mut command, "quantity", get(source, "quantity"));
        }
        "AppraiseItem" => put(&mut command, "item_id", sliced(nn(get(source, "item_id"), get(source, "itemId")), 120)),
        "PurchaseMerchantService" => put(&mut command, "service_id", sliced(nn(get(source, "service_id"), get(source, "serviceId")), 120)),
        _ => {}
    }
    Ok(with_fingerprint(command, merchant_command_fingerprint))
}

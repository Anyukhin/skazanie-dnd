//! Ядро движка правил — общие помощники `rules-engine.mjs`. Задача Р0.
//!
//! JS: `clone`, `assertMechanicsSupported` (1024–1044), `uniqueStrings`,
//! `plainObject` (1209–1215), `abilityModifier` (2221), `diceExpression`
//! (3096), `monsterTraitFor`/`monsterActionFor` (3120–3128), доспехи
//! (3740–3763), `targetFor` (5077), `playerActor` (5128),
//! `objectiveWithinLimit` (5146), `inventoryItem` (5167), `sameCampaignParty`
//! (5426), сборка событий `eventFrom`, `npcWorldEventsFrom`,
//! `heroDiedEventFrom`, `itemGrantedEventFrom`, `commandWithRules`
//! (7880–7981), `actorMaxHp` (7989), `resourcePool` (9191), `conditionIdsFor`
//! (10793), состояния из таблицы (10947–10959), `replaceActor` (23588),
//! `combatActorKind` (23988), `restartTurnClock` (24005), путь журнала
//! `battleLogMovePath` (1114) и вариант реакции «Готовности» `readiedOptionFor`
//! (1874).
//!
//! Событие и команда — JSON той же формы, что в JS: поле, которого в JS нет
//! (`undefined`), здесь не вставляется.

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::js;
use sk_core::{Event, RuleError};
use sk_ruleset::ruleset_config::ruleset_rule_id;

use crate::command::rules::rule_ids;
use crate::constants::{MOVE_BATTLE_LOG_PATH_VERSION, SUMMON_LIFECYCLE_VERSION};
use crate::pause::{Fault, Halt};
use crate::tables::{condition_effect, incapacitating_conditions, speed_zero_conditions};

/// `String(value)` для значения JSON (поле есть): `null` — `"null"`.
pub fn string_of(value: &Value) -> String {
    js::string(Some(value))
}

/// `a ?? b ?? …`: первое значение, которое не `null` и не `undefined`.
pub fn coalesce<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|value| js::present(*value)).flatten()
}

/// `{ ...value }`: собственные поля в порядке JS (индексы по возрастанию,
/// затем прочие ключи), элементы массива и символы строки — ключами-индексами.
pub fn spread_value(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Map::new(),
    }
}

/// `uniqueStrings(value)`: `value.map(String).map(trim).filter(Boolean)` без
/// повторов; не массив — пусто. В отличие от `sk_core::js::unique_strings`
/// обрезает пробелы и печатает `null` как `"null"` — как в движке.
pub fn unique_strings(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else { return Vec::new() };
    let mut seen = IndexSet::new();
    for item in items {
        let text = sk_core::text::trim(&string_of(item)).to_string();
        if !text.is_empty() {
            seen.insert(text);
        }
    }
    seen.into_iter().collect()
}

/// То же для готового списка строк.
pub fn unique_string_list(items: &[String]) -> Vec<String> {
    unique_strings(Some(&js::strings_value(items.iter().cloned())))
}

/// `plainObject(value)`.
pub fn plain_object(value: Option<&Value>) -> bool {
    js::is_plain(value)
}

/// `[...new Set(values)]` для значений JSON: строки, числа, логические и
/// `null` сливаются по значению, объекты и массивы — нет (у них своя ссылка).
pub fn unique_values(values: Vec<Value>) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::with_capacity(values.len());
    for value in values {
        let primitive = !matches!(value, Value::Object(_) | Value::Array(_));
        if primitive && result.iter().any(|existing| same_value_zero(existing, &value)) {
            continue;
        }
        result.push(value);
    }
    result
}

fn same_value_zero(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => left == right,
    }
}

/// `text.slice(0, limit)` по единицам UTF-16, как в JS. Срез посреди
/// суррогатной пары (в JS — одинокий суррогат) обрезается до целого символа.
pub fn slice_utf16(text: &str, limit: usize) -> String {
    let mut units = 0usize;
    let mut result = String::new();
    for ch in text.chars() {
        let width = ch.len_utf16();
        if units + width > limit {
            break;
        }
        units += width;
        result.push(ch);
    }
    result
}

/// Длина строки в единицах UTF-16 (`text.length`).
pub fn len_utf16(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `abilityModifier(score)`: `Math.floor((safeInteger(score, 10) - 10) / 2)`.
pub fn ability_modifier(score: Option<&Value>) -> i64 {
    (js::safe_int(score, 10) - 10).div_euclid(2)
}

/// `diceExpression(dice, bonus, fallbackSides)`: строка кубов или число
/// граней, с бонусом; неразборчивое — `1d<fallback>`.
pub fn dice_expression(dice: Option<&Value>, bonus: Option<&Value>, fallback_sides: i64) -> Result<String, Halt> {
    let expression = match dice {
        Some(Value::String(text)) => text.clone(),
        other => format!("1d{}", js::safe_int(other, fallback_sides)),
    };
    let parsed = match sk_dice::parse_dice_expression(&expression) {
        Ok(parsed) => parsed,
        Err(_) => sk_dice::parse_dice_expression(&format!("1d{fallback_sides}")).map_err(dice_fault)?,
    };
    let modifier = parsed.modifier + js::safe_int(bonus, 0);
    Ok(format!("{}d{}{}", parsed.count, parsed.sides, signed(modifier)))
}

/// `+N`, `-N` или пусто.
pub fn signed(modifier: i64) -> String {
    match modifier.signum() {
        1 => format!("+{modifier}"),
        -1 => modifier.to_string(),
        _ => String::new(),
    }
}

/// Ошибка кубов JS (`DiceExpressionError`, `RangeError`).
pub fn dice_fault(error: sk_dice::DiceError) -> Halt {
    let name = match error {
        sk_dice::DiceError::Expression(_) => "DiceExpressionError",
        sk_dice::DiceError::Range(_) => "RangeError",
        sk_dice::DiceError::Transcript(_) => "Error",
    };
    let message = match &error {
        sk_dice::DiceError::Expression(text) | sk_dice::DiceError::Range(text) | sk_dice::DiceError::Transcript(text) => text.clone(),
    };
    Halt::Fault(Fault::new(name, message))
}

/// `monsterTraitFor(actor, traitId)`: `String(trait?.id ?? trait) === String(traitId)`.
pub fn monster_trait_for<'a>(actor: Option<&'a Value>, trait_id: &str) -> Option<&'a Value> {
    actor?.get("traits")?.as_array()?.iter().find(|entry| {
        let key = match entry.get("id").filter(|id| !id.is_null()) {
            Some(id) => string_of(id),
            None => string_of(entry),
        };
        key == trait_id
    })
}

/// `monsterActionFor(actor, actionId)`: по id или первое действие.
pub fn monster_action_for<'a>(actor: Option<&'a Value>, action_id: Option<&Value>) -> Option<&'a Value> {
    let actions = actor.and_then(|actor| actor.get("action_profiles")).and_then(Value::as_array)?;
    if js::truthy(action_id) {
        let wanted = js::string(action_id);
        return actions.iter().find(|action| js::string(action.get("id")) == wanted);
    }
    actions.first()
}

fn equipped_catalog_entries(actor: Option<&Value>) -> Vec<&'static Value> {
    actor
        .and_then(|actor| actor.get("inventory"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| js::truthy(item.get("equipped")))
        .filter_map(|item| {
            let catalog_id = coalesce(&[item.get("catalog_id"), item.get("catalogId")]);
            sk_items::item_catalog::catalog_item(&js::s(catalog_id))
        })
        .collect()
}

/// `hasEquippedShield(actor)`.
pub fn has_equipped_shield(actor: Option<&Value>) -> bool {
    equipped_catalog_entries(actor).into_iter().any(|entry| {
        let equip = entry.get("equip");
        equip.and_then(|equip| equip.get("slot")).and_then(Value::as_str) == Some("off_hand")
            && equip.and_then(|equip| equip.get("armor")).and_then(|armor| armor.get("kind")).and_then(Value::as_str) == Some("shield")
    })
}

/// `armorRestrictions(actor)`: надетые доспехи (не щиты) из каталога.
pub fn armor_restrictions(actor: Option<&Value>) -> Vec<&'static Value> {
    equipped_catalog_entries(actor)
        .into_iter()
        .filter_map(|entry| entry.get("equip").and_then(|equip| equip.get("armor")))
        .filter(|armor| armor.get("kind").and_then(Value::as_str) == Some("armor"))
        .collect()
}

/// `armorStealthDisadvantage(actor)`.
pub fn armor_stealth_disadvantage(actor: Option<&Value>) -> bool {
    armor_restrictions(actor).into_iter().any(|armor| js::is_true(armor.get("stealthDisadvantage")))
}

/// `armorStrengthSpeedPenalty(actor)`: −10 футов в доспехе не по силе.
pub fn armor_strength_speed_penalty(actor: Option<&Value>) -> i64 {
    let strength = js::safe_int(actor.and_then(|actor| actor.get("abilities")).and_then(|abilities| abilities.get("str")), 10);
    if armor_restrictions(actor).into_iter().any(|armor| strength < js::safe_int(armor.get("strengthRequirement"), 0)) {
        10
    } else {
        0
    }
}

/// `targetFor(command)`: `target_id || target_ids[0] || actor_id`.
pub fn target_for(command: &Value) -> Value {
    let target = command.get("target_id");
    if js::truthy(target) {
        return target.cloned().unwrap_or(Value::Null);
    }
    let first = command.get("target_ids").and_then(Value::as_array).and_then(|ids| ids.first());
    if js::truthy(first) {
        return first.cloned().unwrap_or(Value::Null);
    }
    command.get("actor_id").cloned().unwrap_or(Value::Null)
}

/// `playerActor(state, id)`: герой с `String(player.id) === String(id ?? '')`.
pub fn player_actor<'a>(state: &'a Value, id: Option<&Value>) -> Option<&'a Value> {
    sk_core::game::player_actor(state, &js::s(id))
}

/// `objectiveWithinLimit(value, maximum)`: цель в пределах длины, обрезанная
/// по границе слова с многоточием.
pub fn objective_within_limit(value: Option<&Value>, maximum: usize) -> String {
    let raw = if js::truthy(value) { js::s(value) } else { String::new() };
    let text = sk_core::text::squash_spaces(&raw);
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= maximum {
        return text;
    }
    let cut = &units[..maximum.saturating_sub(1)];
    let space = cut.iter().rposition(|unit| *unit == u16::from(b' '));
    let kept = match space {
        Some(index) if (index as f64) > maximum as f64 / 2.0 => &cut[..index],
        _ => cut,
    };
    let kept = String::from_utf16_lossy(kept);
    let trimmed = kept.trim_end_matches(|ch: char| sk_core::text::is_js_space(ch) || matches!(ch, ',' | ';' | ':' | '—' | '-'));
    format!("{trimmed}…")
}

/// `inventoryItem(actor, itemId)`.
pub fn inventory_item<'a>(actor: Option<&'a Value>, item_id: Option<&Value>) -> Option<&'a Value> {
    let wanted = js::s(item_id);
    actor?.get("inventory")?.as_array()?.iter().find(|item| js::string(item.get("id")) == wanted)
}

/// `sameCampaignParty(state, id)`: герой из отряда этой кампании.
pub fn same_campaign_party(state: &Value, id: &str) -> bool {
    let members = state.get("partyMemberIds").and_then(Value::as_array).filter(|ids| !ids.is_empty());
    match members {
        Some(ids) => ids.iter().any(|member| string_of(member) == id),
        None => state.get("players").and_then(Value::as_array).into_iter().flatten().any(|player| sk_core::game::actor_id(player) == id),
    }
}

/// `assertMechanicsSupported(subject, label)`: отказ называет причину карточки.
pub fn assert_mechanics_supported(subject: Option<&Value>, label: &str) -> Result<(), RuleError> {
    let support = subject.and_then(|subject| subject.get("mechanicsSupport")).and_then(Value::as_str);
    if matches!(support, Some("verified" | "partial")) {
        return Ok(());
    }
    let reason = sk_core::text::trim(&js::s(subject.and_then(|subject| subject.get("supportNote")))).to_string();
    if support == Some("heuristic") {
        return Err(RuleError::new("MECHANICS_NOT_VERIFIED", format!("Механика {label} ещё не проверена для авторитетного боя")));
    }
    let message = if reason.is_empty() {
        format!("Для {label} требуется серверное решение правил")
    } else {
        format!("Для {label} требуется серверное решение правил: {reason}")
    };
    Err(RuleError::new("RULING_REQUIRED", message))
}

/// События, которым `eventFrom` ставит маркер жизненного цикла призыва.
const SUMMON_LIFECYCLE_EVENT_TYPES: [&str; 4] = ["ConcentrationEnded", "SummonedCreatureDismissed", "HeroDied", "HitPointsReducedToZero"];

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|map| map.get(key))
}

/// `[...command.source_rule_ids]` как значения JSON.
fn command_rule_ids(command: &Value) -> Vec<Value> {
    command.get("source_rule_ids").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `eventFrom(command, eventType, payload = {}, targets = command.target_ids)`.
///
/// `payload: None` — значение по умолчанию `{}`; `targets: None` — по умолчанию
/// `command.target_ids` (так же, как явный `undefined` в JS).
pub fn event_from(command: &Value, event_type: &str, payload: Option<Value>, targets: Option<&Value>) -> Value {
    let original = payload.unwrap_or_else(js::obj);
    let lifecycle_marked = SUMMON_LIFECYCLE_EVENT_TYPES.contains(&event_type)
        && !js::present(field(&original, "summon_lifecycle_version"))
        && !js::present(field(&original, "summonLifecycleVersion"));
    let mut versioned = if lifecycle_marked {
        let mut map = spread_value(Some(&original));
        map.insert("summon_lifecycle_version".into(), Value::from(SUMMON_LIFECYCLE_VERSION));
        Value::Object(map)
    } else {
        original.clone()
    };
    if event_type == "ActorMoved" && field(&original, "path").is_some_and(Value::is_array) && !js::present(field(&original, "battle_log_path_version")) {
        let mut map = spread_value(Some(&versioned));
        map.insert("battle_log_path_version".into(), Value::from(MOVE_BATTLE_LOG_PATH_VERSION));
        versioned = Value::Object(map);
    }
    let mut payload_rule_ids: Vec<&str> = Vec::new();
    if js::truthy(field(&original, "resistance_cantrip_reduction")) || js::truthy(field(&original, "aura_of_life_source")) {
        payload_rule_ids.push(rule_ids::RESISTANCE);
    }
    if js::truthy(field(&original, "aura_of_protection_source")) {
        payload_rule_ids.push(rule_ids::AURA_OF_PROTECTION);
    }
    if js::is_true(field(&original, "indomitable_applied")) || js::truthy(field(&original, "indomitable_bonus")) {
        payload_rule_ids.push(rule_ids::INDOMITABLE);
    }
    let ruleset = js::s(command.get("ruleset_id"));
    let mut source_rule_ids = command_rule_ids(command);
    source_rule_ids.extend(payload_rule_ids.into_iter().map(|rule_id| Value::String(ruleset_rule_id(rule_id, &ruleset))));
    let targets = match targets {
        None => command.get("target_ids"),
        Some(targets) => Some(targets),
    };
    let mut event = Map::new();
    event.insert("campaign_id".into(), command.get("campaign_id").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null));
    if let Some(command_id) = command.get("command_id") {
        event.insert("command_id".into(), command_id.clone());
    }
    event.insert("event_type".into(), Value::String(event_type.into()));
    if let Some(actor_id) = command.get("actor_id") {
        event.insert("actor_id".into(), actor_id.clone());
    }
    event.insert("target_ids".into(), js::strings_value(unique_strings(targets)));
    event.insert("payload".into(), versioned);
    event.insert("source_rule_ids".into(), Value::Array(unique_values(source_rule_ids)));
    if let Some(house_rule_id) = command.get("house_rule_id") {
        event.insert("house_rule_id".into(), house_rule_id.clone());
    }
    if let Some(ruling_id) = command.get("ruling_id") {
        event.insert("ruling_id".into(), ruling_id.clone());
    }
    event.insert("visibility".into(), command.get("visibility").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| Value::String("public".into())));
    Value::Object(event)
}

/// `{ ...command, [key]: value }`.
pub fn command_with(command: &Value, key: &str, value: Value) -> Value {
    let mut map = spread_value(Some(command));
    map.insert(key.into(), value);
    Value::Object(map)
}

/// `npcWorldEventsFrom(command, drafts)`: черновики модулей мира NPC в события.
pub fn npc_world_events_from(command: &Value, drafts: &Value) -> Vec<Value> {
    drafts
        .as_array()
        .into_iter()
        .flatten()
        .map(|draft| {
            let visibility = coalesce(&[draft.get("visibility"), command.get("visibility")]);
            let source = match visibility {
                Some(visibility) => command_with(command, "visibility", visibility.clone()),
                None => {
                    let mut map = spread_value(Some(command));
                    map.shift_remove("visibility");
                    Value::Object(map)
                }
            };
            let event_type = js::s(draft.get("event_type"));
            let mut event = event_from(&source, &event_type, draft.get("payload").cloned(), draft.get("target_ids"));
            if js::truthy(draft.get("event_id")) {
                event["event_id"] = draft["event_id"].clone();
            }
            event
        })
        .collect()
}

/// `heroDiedEventFrom(command, payload, targets)`: `HeroDied` второй схемы.
pub fn hero_died_event_from(command: &Value, payload: Option<Value>, targets: Option<&Value>) -> Value {
    let mut event = event_from(command, "HeroDied", payload, targets);
    event["event_schema_version"] = Value::from(2);
    event
}

/// `itemGrantedEventFrom(command, payload, targets)`: `ItemGranted` второй схемы.
pub fn item_granted_event_from(command: &Value, payload: Option<Value>, targets: Option<&Value>) -> Value {
    let mut event = event_from(command, "ItemGranted", payload, targets);
    event["event_schema_version"] = Value::from(2);
    event
}

/// `commandWithRules(command, ...ruleIds)`: команда с добавленными правилами
/// в редакции кампании.
pub fn command_with_rules(command: &Value, rules: &[&str]) -> Value {
    let ruleset = js::s(command.get("ruleset_id"));
    let mut ids = command_rule_ids(command);
    ids.extend(rules.iter().filter(|rule_id| !rule_id.is_empty()).map(|rule_id| Value::String(ruleset_rule_id(rule_id, &ruleset))));
    command_with(command, "source_rule_ids", Value::Array(unique_values(ids)))
}

/// `actorMaxHp(actor)`.
pub fn actor_max_hp(actor: Option<&Value>) -> i64 {
    actor.map(sk_core::game::actor_max_hp).unwrap_or(1)
}

/// Запас ресурса `{ current, max }` (`resourcePool`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pool {
    pub current: i64,
    pub max: i64,
}

impl Pool {
    pub fn to_value(self) -> Value {
        json!({ "current": self.current, "max": self.max })
    }
}

/// `resourcePool(state, actorId, resourceName, providedMax = 0)`.
pub fn resource_pool(state: &Value, actor_id: &str, resource: &str, provided_max: i64) -> Pool {
    let pool = sk_core::game::mechanics(state).get("resources").and_then(|all| all.get(actor_id)).and_then(|pools| pools.get(resource));
    let max = js::safe_int(pool.and_then(|pool| pool.get("max")), provided_max).max(0);
    Pool { current: js::safe_int(pool.and_then(|pool| pool.get("current")), max).max(0), max }
}

/// `conditionIdsFor(state, id)`: множество id состояний в порядке списка.
pub fn condition_ids_for(state: &Value, id: &str) -> IndexSet<String> {
    sk_core::game::condition_ids(state, id)
}

/// `incapacitatingConditionFor(state, id)`: первое по таблице состояние,
/// выводящее существо из боя.
pub fn incapacitating_condition_for(state: &Value, id: &str) -> Option<&'static str> {
    let conditions = condition_ids_for(state, id);
    incapacitating_conditions().iter().copied().find(|condition| conditions.contains(*condition))
}

/// `speedZeroConditionFor(state, id)`; «Свобода перемещения» гасит обнуление.
pub fn speed_zero_condition_for(state: &Value, id: &str) -> Option<&'static str> {
    let conditions = condition_ids_for(state, id);
    if conditions.iter().any(|condition| condition_effect(condition).and_then(|effect| effect.get("immuneToSpeedZero")) == Some(&Value::Bool(true))) {
        return None;
    }
    speed_zero_conditions().into_iter().find(|condition| conditions.contains(*condition))
}

/// `ignoresDifficultTerrain(state, id)`.
pub fn ignores_difficult_terrain(state: &Value, id: &str) -> bool {
    condition_ids_for(state, id).iter().any(|condition| condition_effect(condition).and_then(|effect| effect.get("ignoresDifficultTerrain")) == Some(&Value::Bool(true)))
}

/// `replaceActor(state, id, updater)`.
pub fn replace_actor(state: &mut Value, id: &str, update: impl FnMut(&mut Value)) {
    sk_core::game::replace_actor(state, id, update)
}

/// `combatActorKind(state, id)`: `enemy`, `summon` или `player`.
pub fn combat_actor_kind(state: &Value, id: &str) -> &'static str {
    sk_core::game::combat_actor_kind(state, id)
}

/// `restartTurnClock(state, event)`: новый срок текущего хода из самого события.
pub fn restart_turn_clock(state: &mut Value, event: &Event) {
    let created_at = event.extra.get("created_at");
    if !js::truthy(created_at) {
        return;
    }
    let created_at = created_at.cloned().unwrap_or(Value::Null);
    let event_id = event.extra.get("event_id").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null);
    let combat = sk_core::game::combat_mut(state);
    combat["turn_started_at"] = created_at;
    combat["turn_started_event_id"] = event_id;
}

/// `battleLogMovePath(payload)`: путь шага для журнала — только целые клетки.
pub fn battle_log_move_path(payload: Option<&Value>) -> Option<Vec<Value>> {
    let payload = payload?;
    if js::number(payload.get("battle_log_path_version")) != MOVE_BATTLE_LOG_PATH_VERSION as f64 {
        return None;
    }
    if js::is_true(payload.get("teleport")) {
        return None;
    }
    let points = payload.get("path")?.as_array()?;
    let mut path = Vec::with_capacity(points.len());
    for point in points {
        let x = js::number(point.get("x"));
        let y = js::number(point.get("y"));
        if !is_safe_integer_f64(x) || !is_safe_integer_f64(y) {
            return None;
        }
        path.push(json!({ "x": x as i64, "y": y as i64 }));
    }
    (!path.is_empty()).then_some(path)
}

/// `Number.isSafeInteger(x)` для числа.
pub fn is_safe_integer_f64(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

/// `readiedOptionFor(readied, reason)`: что предложить в окне реакции.
pub fn readied_option_for(readied: Option<&Value>, reason: Option<&str>) -> Value {
    let reason = reason.unwrap_or("Триггер сработал");
    let spell_id = readied.and_then(|readied| readied.get("spell_id"));
    if js::truthy(spell_id) {
        let name = coalesce(&[readied.and_then(|readied| readied.get("spell_name")), spell_id]);
        return json!({
            "id": "readied-spell",
            "name": format!("Выпустить: {}", js::string(name)),
            "description": format!("{reason} — отпустить удерживаемое заклинание."),
            "resource": null,
            "cost": 1,
        });
    }
    json!({
        "id": "readied-attack",
        "name": "Заготовленная атака",
        "description": format!("{reason} — нанести заготовленный удар."),
        "resource": null,
        "cost": 1,
    })
}

/// `conditionUsesEffectIdentity(condition, payload)`: у булевых состояний и
/// повторяющихся спасбросков свой экземпляр на каждый источник.
pub fn condition_uses_effect_identity(condition: &str, payload: Option<&Value>) -> bool {
    let field = |key: &str| payload.and_then(|payload| payload.get(key));
    if !js::present(field("effect_id")) {
        return false;
    }
    condition == "longstrider"
        || condition.starts_with("protected-from-energy:")
        || crate::constants::SOURCE_SCOPED_BOOLEAN_CONDITIONS.contains(&condition)
        || js::present(field("repeat_save_timing"))
        || js::is_true(field("repeat_save_on_damage"))
        || js::present(field("escape_check_ability"))
        || js::present(field("start_turn_save"))
        || field("spell_id").and_then(Value::as_str) == Some("vitriolic-sphere") && field("recurring_damage_timing").and_then(Value::as_str) == Some("turn-end")
}

/// `castingTimeMinutes(castingTime)`: минуты накладывания по первому числу с
/// единицей; непонятная строка — 0.
pub fn casting_time_minutes(casting_time: Option<&Value>) -> f64 {
    let text = js::s(casting_time);
    let regex = sk_core::re!(r"(\d+)\s*(минут|мин|час|часа|часов|день|дня|дней|сутки|суток)", "iu");
    let Ok(Some(captures)) = regex.captures(&text) else { return 0.0 };
    let count = captures.get(1).map(|m| m.as_str()).unwrap_or("0");
    let unit = sk_core::text::lower(captures.get(2).map(|m| m.as_str()).unwrap_or(""));
    let per_unit = if unit.starts_with("час") {
        60.0
    } else if ["день", "дня", "дней", "сутки", "суток"].contains(&unit.as_str()) {
        1_440.0
    } else {
        1.0
    };
    (js::parse_number(count) * per_unit).max(0.0)
}

/// `safeInteger(value, fallback = 0)` с запасом-значением: число, если `value`
/// — безопасное целое, иначе сам запас как есть; запас `undefined` (`None`)
/// по умолчанию — 0, а `null` остаётся `null`.
pub fn safe_integer_or(value: Option<&Value>, fallback: Option<&Value>) -> Value {
    let number = js::number(value);
    if is_safe_integer_f64(number) {
        Value::from(number as i64)
    } else {
        fallback.cloned().unwrap_or(Value::from(0))
    }
}

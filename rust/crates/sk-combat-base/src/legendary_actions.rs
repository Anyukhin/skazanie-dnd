//! Перенос `server/legendary-actions.mjs`: легендарные действия и
//! Легендарное сопротивление.
//!
//! Модуль без состояния: стат-блок нормализуется здесь один раз для движка
//! правил (проверка, события, сброс в начале хода) и для планировщика ходов
//! (выбор действия), чтобы второго описания стат-блока не было. Потраченное
//! учитывается маркерами состояний (`legendary-action-used:<n>:<окно>`,
//! `legendary-resistance-used:<n>`, `legendary-cooldown:<id>`), отдельного
//! счётчика в состоянии нет.
//!
//! Нормализованный профиль — структуры Rust; `to_json` даёт форму JS
//! (`attackModifier`, `rangeFeet`, …). Числа, которые в JS могут оказаться
//! `Infinity` (`attack_modifier: "Infinity"`), хранятся в `f64`.

use serde_json::{json, Value};
use sk_core::{js, text};

use crate::jsv::{self, nullish, string_of};

/// `LEGENDARY_POLICY_ID`.
pub const LEGENDARY_POLICY_ID: &str = "legendary-actions-v1";
/// `LEGENDARY_EVENT_SCHEMA_VERSION`.
pub const LEGENDARY_EVENT_SCHEMA_VERSION: i64 = 1;
/// Потраченное легендарное действие: `legendary-action-used:<n>:<окно>`.
pub const LEGENDARY_ACTION_CONDITION_PREFIX: &str = "legendary-action-used:";
/// Потраченное Легендарное сопротивление: `legendary-resistance-used:<n>`.
pub const LEGENDARY_RESISTANCE_CONDITION_PREFIX: &str = "legendary-resistance-used:";
/// Перезарядка действия по ходам самого существа: `legendary-cooldown:<id>`.
pub const LEGENDARY_COOLDOWN_CONDITION_PREFIX: &str = "legendary-cooldown:";
/// Виды легендарных действий, которые движок действительно исполняет.
pub const LEGENDARY_ACTION_KINDS: [&str; 2] = ["attack", "save"];
/// Состояния, ради которых Легендарное сопротивление стоит жечь.
pub const LEGENDARY_CONTROL_CONDITIONS: [&str; 9] = ["stunned", "paralyzed", "unconscious", "petrified", "incapacitated", "restrained", "banished", "charmed", "frightened"];

const MAXIMUM_USES: f64 = 5.0;
const MAXIMUM_ACTIONS: usize = 6;
const SAVE_ABILITIES: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];

/// `legendaryCooldownMarker(actionId)`.
pub fn legendary_cooldown_marker(action_id: &str) -> String {
    format!("{LEGENDARY_COOLDOWN_CONDITION_PREFIX}{action_id}")
}

/// `Math.trunc(Number(value) || 0)`.
fn trunc_or_zero(value: Option<&Value>) -> f64 {
    let number = js::number(value);
    if number == 0.0 || number.is_nan() {
        0.0
    } else {
        number.trunc()
    }
}

/// `Math.max(0, Math.trunc(Number(value) || 0))` для числа.
fn non_negative_trunc(value: f64) -> f64 {
    if value == 0.0 || value.is_nan() {
        0.0
    } else {
        value.trunc().max(0.0)
    }
}

fn positive_integer(value: Option<&Value>, fallback: f64, maximum: f64) -> i64 {
    let parsed = js::number(value).trunc();
    if !parsed.is_finite() || parsed <= 0.0 {
        return fallback as i64;
    }
    maximum.min(parsed) as i64
}

/// Нормализованное легендарное действие.
#[derive(Debug, Clone, PartialEq)]
pub struct LegendaryAction {
    pub id: String,
    pub name: String,
    pub cost: i64,
    pub kind: String,
    pub attack_modifier: f64,
    pub damage_expression: Option<String>,
    pub damage_type: String,
    pub save_ability: String,
    pub save_dc: Option<f64>,
    pub half_on_save: bool,
    pub condition: Option<String>,
    pub range_feet: i64,
    pub radius_feet: i64,
    /// `cone` или `sphere`.
    pub area_shape: String,
    pub cooldown_turns: i64,
}

impl LegendaryAction {
    /// Форма JS (`Object.freeze({ id, name, cost, kind, attackModifier, … })`).
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "cost": self.cost,
            "kind": self.kind,
            "attackModifier": js::num(self.attack_modifier),
            "damageExpression": self.damage_expression,
            "damageType": self.damage_type,
            "saveAbility": self.save_ability,
            "saveDc": self.save_dc.map(js::num),
            "halfOnSave": self.half_on_save,
            "condition": self.condition,
            "rangeFeet": self.range_feet,
            "radiusFeet": self.radius_feet,
            "areaShape": self.area_shape,
            "cooldownTurns": self.cooldown_turns,
        })
    }
}

/// Нормализованный легендарный блок.
#[derive(Debug, Clone, PartialEq)]
pub struct LegendaryProfile {
    pub uses: i64,
    pub resistance: i64,
    pub actions: Vec<LegendaryAction>,
}

impl LegendaryProfile {
    pub fn to_json(&self) -> Value {
        json!({
            "uses": self.uses,
            "resistance": self.resistance,
            "actions": self.actions.iter().map(LegendaryAction::to_json).collect::<Vec<_>>(),
        })
    }
}

fn normalize_action(entry: &Value) -> Option<LegendaryAction> {
    let field = |key: &str| jsv::member(Some(entry), key);
    let id = js::s(field("id"));
    let kind = string_of(nullish(field("kind"), Some(&Value::String("attack".into()))));
    if id.is_empty() || !LEGENDARY_ACTION_KINDS.contains(&kind.as_str()) {
        return None;
    }
    let name = match field("name") {
        None | Some(Value::Null) => id.clone(),
        name => string_of(name),
    };
    let save_ability = string_of(field("save_ability"));
    let area_shape = string_of(nullish(field("area_shape"), field("areaShape")));
    Some(LegendaryAction {
        name: jsv::utf16_head(&name, 120),
        cost: positive_integer(field("cost"), 1.0, MAXIMUM_USES),
        attack_modifier: trunc_or_zero(nullish(field("attack_modifier"), field("attackModifier"))),
        damage_expression: js::present(field("damage_expression")).then(|| string_of(field("damage_expression"))),
        damage_type: string_of(nullish(field("damage_type"), Some(&Value::String("bludgeoning".into())))),
        save_ability: if SAVE_ABILITIES.contains(&save_ability.as_str()) { save_ability } else { "dex".into() },
        save_dc: js::present(field("save_dc")).then(|| {
            let dc = js::number(field("save_dc"));
            let dc = if dc == 0.0 || dc.is_nan() { 10.0 } else { dc.trunc() };
            dc.max(1.0)
        }),
        half_on_save: js::is_true(field("half_on_save")),
        condition: js::present(field("condition")).then(|| string_of(field("condition"))),
        range_feet: positive_integer(nullish(field("range_feet"), field("rangeFeet")), 5.0, 600.0),
        radius_feet: positive_integer(nullish(field("radius_feet"), field("radiusFeet")), 0.0, 120.0),
        area_shape: if kind == "save" && area_shape == "cone" { "cone".into() } else { "sphere".into() },
        cooldown_turns: trunc_or_zero(nullish(field("cooldown_turns"), field("cooldownTurns"))).min(10.0).max(0.0) as i64,
        kind,
        id,
    })
}

/// `legendaryProfileFor(actor)`: нормализованный блок либо `None`. Действие
/// без исполнимого вида отбрасывается здесь, а не при исполнении.
pub fn legendary_profile_for(actor: Option<&Value>) -> Option<LegendaryProfile> {
    let raw = actor.and_then(|actor| actor.get("legendary")).filter(|raw| raw.is_object())?;
    let actions: Vec<LegendaryAction> = raw.get("actions").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]).iter().filter_map(normalize_action).take(MAXIMUM_ACTIONS).collect();
    if actions.is_empty() {
        return None;
    }
    let resistance = trunc_or_zero(nullish(raw.get("resistance"), raw.get("legendary_resistance"))).min(MAXIMUM_USES).max(0.0) as i64;
    Some(LegendaryProfile { uses: positive_integer(raw.get("uses"), 3.0, MAXIMUM_USES), resistance, actions })
}

/// `isBossActor(actor)`: босс — существо с легендарными действиями.
pub fn is_boss_actor(actor: Option<&Value>) -> bool {
    legendary_profile_for(actor).is_some()
}

/// `legendaryActionFor(actor, actionId)`.
pub fn legendary_action_for(actor: Option<&Value>, action_id: Option<&Value>) -> Option<LegendaryAction> {
    let id = js::s(action_id);
    legendary_profile_for(actor)?.actions.into_iter().find(|action| action.id == id)
}

/// `legendaryWindowKey(combat)`: `r<раунд>i<индекс хода>`.
///
/// Как в JS, `Math.trunc(Number(active_index) ?? -1)`: `??` к числу не
/// применяется, и без `active_index` ключ — `…iNaN`.
pub fn legendary_window_key(combat: Option<&Value>) -> String {
    let round = trunc_or_zero(combat.and_then(|combat| combat.get("round"))).max(0.0);
    let index = js::number(combat.and_then(|combat| combat.get("active_index"))).trunc();
    format!("r{}i{}", js::f64_string(round), js::f64_string(index))
}

/// `legendaryActionMarker(ordinal, windowKey)`.
pub fn legendary_action_marker(ordinal: i64, window_key: &str) -> String {
    format!("{LEGENDARY_ACTION_CONDITION_PREFIX}{ordinal}:{window_key}")
}

/// `legendaryResistanceMarker(ordinal)`.
pub fn legendary_resistance_marker(ordinal: i64) -> String {
    format!("{LEGENDARY_RESISTANCE_CONDITION_PREFIX}{ordinal}")
}

fn count_markers<I, S>(condition_ids: I, prefix: &str) -> usize
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    condition_ids.into_iter().filter(|condition| condition.as_ref().starts_with(prefix)).count()
}

/// `legendaryUsesSpent(conditionIds)`: потрачено между своими ходами.
pub fn legendary_uses_spent<I, S>(condition_ids: I) -> usize
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    count_markers(condition_ids, LEGENDARY_ACTION_CONDITION_PREFIX)
}

/// `legendaryWindowSpent(conditionIds, windowKey)`.
pub fn legendary_window_spent<I, S>(condition_ids: I, window_key: &str) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let suffix = format!(":{window_key}");
    condition_ids.into_iter().any(|condition| {
        let condition = condition.as_ref();
        condition.starts_with(LEGENDARY_ACTION_CONDITION_PREFIX) && condition.ends_with(&suffix)
    })
}

/// `legendaryResistanceSpent(conditionIds)`: сожжено за день.
pub fn legendary_resistance_spent<I, S>(condition_ids: I) -> usize
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    count_markers(condition_ids, LEGENDARY_RESISTANCE_CONDITION_PREFIX)
}

/// Решение `legendaryResistanceDecision`.
#[derive(Debug, Clone, PartialEq)]
pub struct LegendaryResistanceDecision {
    /// `control` или `lethal`.
    pub reason: &'static str,
    pub condition: Option<String>,
    pub ordinal: i64,
    pub remaining_after: i64,
    pub maximum: i64,
}

impl LegendaryResistanceDecision {
    pub fn to_json(&self) -> Value {
        json!({ "reason": self.reason, "condition": self.condition, "ordinal": self.ordinal, "remaining_after": self.remaining_after, "maximum": self.maximum })
    }
}

/// `legendaryResistanceDecision({ actor, spentUses, conditions, damage, hpBefore })`:
/// жечь ли сопротивление на этот провал — только на контроль из
/// [`LEGENDARY_CONTROL_CONDITIONS`] или на смертельный урон.
pub fn legendary_resistance_decision(actor: Option<&Value>, spent_uses: f64, conditions: &[Value], damage: f64, hp_before: f64) -> Option<LegendaryResistanceDecision> {
    let profile = legendary_profile_for(actor)?;
    if profile.resistance <= 0 {
        return None;
    }
    let spent = non_negative_trunc(spent_uses);
    let remaining = profile.resistance as f64 - spent;
    if remaining <= 0.0 {
        return None;
    }
    let controlling = conditions
        .iter()
        .map(|condition| string_of(Some(condition)))
        .find(|condition| LEGENDARY_CONTROL_CONDITIONS.contains(&condition.split(':').next().unwrap_or("")));
    let damage = non_negative_trunc(damage);
    let lethal = damage >= non_negative_trunc(hp_before) && damage > 0.0;
    if controlling.is_none() && !lethal {
        return None;
    }
    Some(LegendaryResistanceDecision {
        reason: if controlling.is_some() { "control" } else { "lethal" },
        condition: controlling,
        ordinal: spent as i64 + 1,
        remaining_after: remaining as i64 - 1,
        maximum: profile.resistance,
    })
}

/// Цель легендарного действия: идентификатор и расстояние в футах.
#[derive(Debug, Clone, PartialEq)]
pub struct LegendaryTarget {
    pub id: String,
    pub distance_feet: f64,
}

/// Выбор `chooseLegendaryAction`.
#[derive(Debug, Clone, PartialEq)]
pub struct LegendaryChoice {
    pub action: LegendaryAction,
    pub target_id: String,
}

impl LegendaryChoice {
    pub fn to_json(&self) -> Value {
        json!({ "action": self.action.to_json(), "target_id": self.target_id })
    }
}

/// `chooseLegendaryAction({ actor, remainingUses, targets, coolingDown })`:
/// самое дорогое доступное действие (при равной цене — меньший id), цель —
/// ближайшая досягаемая (при равенстве — меньший id). Действию с зоной нужны
/// хотя бы две цели в радиусе. `is_cooling_down` — есть ли метка перезарядки.
pub fn choose_legendary_action(actor: Option<&Value>, remaining_uses: f64, targets: &[LegendaryTarget], is_cooling_down: impl Fn(&str) -> bool) -> Option<LegendaryChoice> {
    let profile = legendary_profile_for(actor)?;
    let available = non_negative_trunc(remaining_uses);
    if available <= 0.0 || targets.is_empty() {
        return None;
    }
    let mut affordable: Vec<LegendaryAction> = profile
        .actions
        .into_iter()
        .filter(|action| action.cost as f64 <= available)
        .filter(|action| !is_cooling_down(&legendary_cooldown_marker(&action.id)))
        .filter(|action| {
            if action.radius_feet <= 0 {
                return targets.iter().any(|target| target.distance_feet <= action.range_feet as f64);
            }
            targets.iter().filter(|target| target.distance_feet <= action.radius_feet as f64).count() >= 2
        })
        .collect();
    affordable.sort_by(|left, right| right.cost.cmp(&left.cost).then_with(|| text::locale_compare(&left.id, &right.id)));
    let action = affordable.into_iter().next()?;
    let reach = if action.radius_feet > 0 { action.radius_feet } else { action.range_feet } as f64;
    let mut reachable: Vec<&LegendaryTarget> = targets.iter().filter(|candidate| candidate.distance_feet <= reach).collect();
    reachable.sort_by(|left, right| {
        left.distance_feet.partial_cmp(&right.distance_feet).unwrap_or(std::cmp::Ordering::Equal).then_with(|| text::locale_compare(&left.id, &right.id))
    });
    let target = reachable.first()?;
    Some(LegendaryChoice { target_id: target.id.clone(), action })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn legendary() -> Value {
        json!({
            "uses": 3,
            "resistance": 2,
            "actions": [
                { "id": "tail", "name": "Удар хвостом", "cost": 1, "kind": "attack", "attack_modifier": 9, "damage_expression": "2d8+5", "damage_type": "bludgeoning", "range_feet": 15 },
                { "id": "wings", "name": "Взмах крыльев", "cost": 2, "kind": "save", "save_ability": "dex", "save_dc": 17, "damage_expression": "2d6+5", "damage_type": "bludgeoning", "half_on_save": true, "radius_feet": 15 },
            ],
        })
    }

    #[test]
    fn boss_is_a_creature_with_legendary_actions() {
        assert!(is_boss_actor(Some(&json!({ "id": "boss", "legendary": legendary() }))));
        assert!(!is_boss_actor(Some(&json!({ "id": "wolf" }))));
        assert!(!is_boss_actor(Some(&json!({ "id": "fake", "legendary": { "uses": 3, "actions": [] } }))));
        assert!(!is_boss_actor(Some(&json!({ "id": "fake", "legendary": { "uses": 3, "actions": [{ "id": "x", "kind": "телепортация-души" }] } }))));
        assert_eq!(legendary_profile_for(Some(&json!({ "id": "boss", "legendary": legendary() }))).expect("профиль").actions.len(), 2);
    }

    #[test]
    fn resistance_burns_only_on_control_or_lethal_damage() {
        let actor = json!({ "legendary": legendary() });
        let control = legendary_resistance_decision(Some(&actor), 0.0, &[json!("paralyzed")], 0.0, 120.0).expect("контроль");
        assert_eq!(control.reason, "control");
        let lethal = legendary_resistance_decision(Some(&actor), 0.0, &[], 130.0, 120.0).expect("смерть");
        assert_eq!(lethal.reason, "lethal");
        assert_eq!(legendary_resistance_decision(Some(&actor), 0.0, &[], 9.0, 120.0), None);
        assert_eq!(legendary_resistance_decision(Some(&actor), 2.0, &[json!("stunned")], 0.0, 120.0), None);
        let mut drained = legendary();
        drained["resistance"] = json!(0);
        assert_eq!(legendary_resistance_decision(Some(&json!({ "legendary": drained })), 0.0, &[json!("stunned")], 0.0, 120.0), None);
        assert!(LEGENDARY_CONTROL_CONDITIONS.contains(&"paralyzed") && LEGENDARY_CONTROL_CONDITIONS.contains(&"stunned"));
    }

    #[test]
    fn window_key_and_markers_follow_js() {
        assert_eq!(legendary_window_key(Some(&json!({ "round": 1, "active_index": 0 }))), "r1i0");
        assert_eq!(legendary_window_key(Some(&json!({ "round": 2 }))), "r2iNaN");
        assert_eq!(legendary_window_key(None), "r0iNaN");
        assert_eq!(legendary_action_marker(2, "r1i0"), "legendary-action-used:2:r1i0");
        let conditions = ["legendary-action-used:1:r1i0", "legendary-action-used:2:r1i0", "legendary-resistance-used:1", "prone"];
        assert_eq!(legendary_uses_spent(conditions), 2);
        assert!(legendary_window_spent(conditions, "r1i0"));
        assert!(!legendary_window_spent(conditions, "r1i1"));
        assert_eq!(legendary_resistance_spent(conditions), 1);
    }

    #[test]
    fn choice_prefers_the_costliest_affordable_action() {
        let actor = json!({ "legendary": legendary() });
        let targets = [LegendaryTarget { id: "b".into(), distance_feet: 10.0 }, LegendaryTarget { id: "a".into(), distance_feet: 10.0 }];
        let choice = choose_legendary_action(Some(&actor), 3.0, &targets, |_| false).expect("выбор");
        assert_eq!((choice.action.id.as_str(), choice.target_id.as_str()), ("wings", "a"));
        let single = choose_legendary_action(Some(&actor), 3.0, &targets[..1], |_| false).expect("один");
        assert_eq!(single.action.id, "tail");
        assert_eq!(choose_legendary_action(Some(&actor), 0.0, &targets, |_| false), None);
    }
}

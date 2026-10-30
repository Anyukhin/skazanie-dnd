//! Ветки `resolveCommandInternal`: концентрация (`StartConcentration`,
//! `EndConcentration`) и заклинание `CastSpell` — общая часть авторитетного
//! пути (16846–17241), выбор вида, дополнительные лучи (18783–18820) и
//! неавторитетная запись (18823–18830). Виды заклинаний — соседние файлы
//! `spell/`. Задача Р9.
//!
//! JS: `server/rules-engine.mjs`, 16836–16838, 16839–16844, 16845–18832;
//! прокси NPC сцены для заклинаний — 13049–13051. Диспетчер —
//! `resolve/dispatch.rs` (Р0); ветка дописывает события в `r.events` и
//! броски в `r.rolls`.
//!
//! Локальные переменные общей части JS, которые читают ветки видов, собраны
//! в [`Cast`].

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::js;
use sk_geometry::Point;

use super::super::Resolve;
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, command_with_rules, condition_ids_for, dice_expression, event_from, slice_utf16, spread_value};
use crate::executable::Executable;
use crate::pause::{rule, Halt, Step};
use crate::replay::apply_game_event;
use crate::tactical_geometry::npc_positioning::NpcTarget;
use crate::tactical_geometry::point_json;

// --- общие помощники веток заклинания ----------------------------------------

/// `value?.[key]` для объекта.
pub(super) fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

/// `value?.[key]` как значение (отсутствие — `None`).
pub(super) fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    at(Some(value), key)
}

/// `value ?? fallback` (поле `null` и отсутствующее поле — «нет значения»).
pub(super) fn nn(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// `x === true`.
pub(super) fn is_true(value: Option<&Value>) -> bool {
    js::is_true(value)
}

/// `Number(x) > 0`.
pub(super) fn positive(value: Option<&Value>) -> bool {
    js::number(value) > 0.0
}

/// Поле в объект, если значение определено (JS кладёт `undefined`, и
/// `JSON.stringify` его выбрасывает).
pub(super) fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// `{ ...a, ...b }` для двух объектов.
pub(super) fn extend(map: &mut Map<String, Value>, tail: Map<String, Value>) {
    for (key, value) in tail {
        map.insert(key, value);
    }
}

/// `{ ...value, [key]: … }`.
pub(super) fn with_fields(value: &Value, fields: &[(&str, Option<Value>)]) -> Value {
    let mut map = spread_value(Some(value));
    for (key, field) in fields {
        match field {
            Some(field) => {
                map.insert((*key).into(), field.clone());
            }
            // `{ ...spell, key: undefined }`: в JS ключ остаётся с `undefined`,
            // и все читатели видят «нет значения».
            None => {
                map.shift_remove(*key);
            }
        }
    }
    Value::Object(map)
}

/// Точка JSON или `null`.
pub(super) fn point_value(point: Option<Point>) -> Value {
    point.map(point_json).unwrap_or(Value::Null)
}

/// `events.reduce(applyGameEvent, state)`.
pub(super) fn fold(state: &Value, events: &[Value]) -> Result<Value, Halt> {
    let mut current = state.clone();
    for event in events {
        current = apply_game_event(&current, event)?;
    }
    Ok(current)
}

/// `events.slice(0, -1).reduce(applyGameEvent, state)`.
pub(super) fn fold_but_last(state: &Value, events: &[Value]) -> Result<Value, Halt> {
    fold(state, &events[..events.len().saturating_sub(1)])
}

/// `actorHp(actor)` для возможного отсутствия.
pub(super) fn hp(actor: Option<&Value>) -> i64 {
    actor.map(sk_core::game::actor_hp).unwrap_or(0)
}

/// `isLivingActor(actor)` для возможного отсутствия.
pub(super) fn living(actor: Option<&Value>) -> bool {
    actor.is_some_and(sk_core::game::is_living_actor)
}

/// `actorId(actor)`.
pub(super) fn actor_id_of(actor: &Value) -> String {
    sk_core::game::actor_id(actor)
}

/// `payload.hp_after === 0`.
pub(super) fn hp_after_zero(payload: &Value) -> bool {
    payload.get("hp_after").and_then(Value::as_f64) == Some(0.0)
}

/// `{ ...payload, extra }` для события урона или броска.
pub(super) fn payload_with(payload: &Value, extra: Value) -> Value {
    let mut map = spread_value(Some(payload));
    if let Value::Object(tail) = extra {
        extend(&mut map, tail);
    }
    Value::Object(map)
}

/// `(spell.list ?? []).includes(value)` для строк.
pub(super) fn list_includes(list: Option<&Value>, value: &str) -> bool {
    list.and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| item.as_str() == Some(value)))
}

/// `Boolean(x?.length)`: непустой массив или строка.
pub(super) fn has_length(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        _ => false,
    }
}

/// Элементы массива (не массив — пусто, как `?? []` у массивов карточек).
pub(super) fn items(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `` `rounds:${x}` `` и прочие шаблоны: `String(x)`.
pub(super) fn template(value: Option<&Value>) -> String {
    js::string(value)
}

/// `Math.max(spell.level, safeInteger(command.slot_level, spell.level))`.
pub(super) fn slot_level_of(spell: &Value, command: &Value) -> i64 {
    let level = level_of(spell);
    level.max(js::safe_int(command.get("slot_level"), level))
}

/// `spell.level` числом (каталог задаёт круг числом).
pub(super) fn level_of(spell: &Value) -> i64 {
    crate::spells::slots::spell_level(spell)
}

/// `diceService.roll(…)` с записью броска и событием `DieRolled`.
impl Resolve<'_> {
    /// `diceService.roll(expression, purpose, command.actor_id, command.visibility ?? 'public')`.
    pub(super) fn spell_roll(&mut self, expression: Value, purpose: &str) -> Result<Value, Halt> {
        let actor = self.command.get("actor_id").cloned().unwrap_or(Value::Null);
        let visibility = self.visibility();
        self.roll_dice(expression, purpose, actor, visibility)
    }

    /// `events.push(eventFrom(command, 'DieRolled', payload, []))`.
    pub(super) fn push_die(&mut self, payload: Value) {
        let event = event_from(&self.command, "DieRolled", Some(payload), Some(&json!([])));
        self.events.push(event);
    }

    /// `events.push(eventFrom(commandWithRules(command, …rules), type, payload, targets))`.
    pub(super) fn push_ruled(&mut self, rules: &[&str], event_type: &str, payload: Value, targets: Value) {
        let source = command_with_rules(&self.command, rules);
        let event = event_from(&source, event_type, Some(payload), Some(&targets));
        self.events.push(event);
    }

    /// `zeroHitPointDamageConsequences(state, command, targetId, payload, { critical })`.
    pub(super) fn push_zero_hp(&mut self, state: &Value, target_id: &str, payload: &Value, critical: bool) {
        let consequences = crate::death::zero_hit_point_damage_consequences(state, &self.command, target_id, payload, critical);
        self.events.extend(consequences);
    }

    /// `rollSavingThrow(state, targetId, options)` для заклинания.
    pub(super) fn spell_save(&mut self, state: &Value, target_id: &str, options: Value) -> Result<Value, Halt> {
        self.roll_saving_throw(state, Some(&Value::String(target_id.into())), &options)
    }

    /// `areaEntryConsequences(events.reduce(applyGameEvent, state), command, id,
    /// from, to, { …, trigger: 'forced-entry' })`.
    pub(super) fn forced_entry(&mut self, moved_id: &str, from: &Value, to: &Value) -> Step {
        let state = fold(&self.state, &self.events)?;
        let consequences = self.area_entry_consequences(&state, moved_id, Some(from), Some(to), Some("forced-entry"))?;
        self.events.extend(consequences);
        Ok(())
    }

    /// Принудительное перемещение заклинанием: `ActorMoved` и вход в области.
    /// `extra` — поля события после `forced_movement` (`pushed`/`pulled`,
    /// `spell_id`, …), `movement_remaining` считается по `speed_state`.
    pub(super) fn forced_spell_move(&mut self, moved_id: &str, from: Option<Point>, path: &[Point], distance: i64, remaining: i64, extra: Value) -> Step {
        let Some(last) = path.last().copied() else { return Ok(()) };
        let mut payload = Map::new();
        payload.insert("from".into(), point_value(from));
        payload.insert("to".into(), point_json(last));
        payload.insert("path".into(), crate::tactical_geometry::points_json(path));
        payload.insert("distance".into(), Value::from(distance));
        payload.insert("movement_cost".into(), Value::from(0));
        payload.insert("movement_spent".into(), Value::from(0));
        payload.insert("movement_remaining".into(), Value::from(remaining));
        payload.insert("spend_movement".into(), Value::Bool(false));
        payload.insert("forced_movement".into(), Value::Bool(true));
        if let Value::Object(tail) = extra {
            extend(&mut payload, tail);
        }
        self.push_ruled(&[rule_ids::CONDITIONS], "ActorMoved", Value::Object(payload), json!([moved_id]));
        self.forced_entry(moved_id, &point_value(from), &point_json(last))
    }
}

// --- концентрация (16836–16844) ----------------------------------------------

/// `StartConcentration` (16836–16838).
pub fn start_concentration(r: &mut Resolve<'_>) -> Step {
    let command = &r.command;
    let effect_id = match command.get("effect_id").filter(|value| js::truthy(Some(value))).or_else(|| command.get("effectId").filter(|value| js::truthy(Some(value)))) {
        Some(value) => js::string(Some(value)),
        None => (r.uuid)(),
    };
    let targets = json!([command.get("actor_id").cloned().unwrap_or(Value::Null)]);
    let event = event_from(&r.command, "ConcentrationStarted", Some(json!({ "effect_id": effect_id })), Some(&targets));
    r.events.push(event);
    Ok(())
}

/// `EndConcentration` (16839–16844).
pub fn end_concentration(r: &mut Resolve<'_>) -> Step {
    let command = &r.command;
    let mut payload = Map::new();
    let reason = command.get("reason").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value))).unwrap_or_else(|| "voluntary".into());
    payload.insert("reason".into(), Value::String(reason));
    if let Some(effect) = command.get("effect_id").filter(|value| js::truthy(Some(value))).or_else(|| command.get("effectId").filter(|value| js::truthy(Some(value)))) {
        payload.insert("effect_id".into(), Value::String(js::string(Some(effect))));
    }
    let targets = json!([command.get("actor_id").cloned().unwrap_or(Value::Null)]);
    let event = event_from(&r.command, "ConcentrationEnded", Some(Value::Object(payload)), Some(&targets));
    r.events.push(event);
    Ok(())
}

/// Боевой лист видимого NPC сцены для заклинания 2014 (13071–13073):
/// `npcInteractionTargetForViewer(state, id)` и `npcCombatActorFor(state, id)`.
/// `None` — NPC не цель (пропустить). Вызывается только для id, у которых нет
/// листа в бою.
pub fn npc_spell_proxy_for(state: &Value, id: &str) -> Result<Option<Value>, Halt> {
    if crate::tactical_geometry::npc_positioning::npc_interaction_target_for_viewer(state, id).is_none() {
        return Ok(None);
    }
    Ok(crate::tactical_geometry::npc_positioning::npc_combat_actor_for(state, id))
}

// --- CastSpell ----------------------------------------------------------------

/// Локальные переменные общей части `CastSpell`, которые читают ветки видов.
pub(super) struct Cast {
    /// `command` после дополнений общей части (Сопротивление 2014).
    pub command: Value,
    /// `command.actor_id` строкой.
    pub actor_id: String,
    /// `findActor(state, command.actor_id)`.
    pub actor: Option<Value>,
    /// Исполнимая карточка: обработчики вида заклинания получают только её.
    pub spell: Executable,
    pub spell_ability: String,
    pub spell_modifier: i64,
    pub spell_attack_modifier: i64,
    pub spell_save_dc: i64,
    /// `shillelaghItemId`.
    pub shillelagh_item_id: Option<String>,
    /// `${spell.id}:${command.command_id}`.
    pub effect_id: String,
    pub affected: Vec<Value>,
    pub npc_affected: Vec<NpcTarget>,
    /// `damageExpression` (`null` — урона нет).
    pub damage_expression: Option<Value>,
    pub metamagic: IndexSet<String>,
    pub damage_type: Value,
    /// `effectiveRange` (`None` — `undefined`).
    pub effective_range: Option<Value>,
    pub spell_cast_event_id: String,
}

impl Cast {
    /// `spell[key]`.
    pub(super) fn spell(&self, key: &str) -> Option<&Value> {
        field(&self.spell, key)
    }

    /// `spell.id` строкой шаблона.
    pub(super) fn spell_id(&self) -> String {
        template(self.spell("id"))
    }

    /// `effectiveRange > 5 ? 'ranged' : 'melee'`.
    pub(super) fn range_kind(&self) -> &'static str {
        if js::number(self.effective_range.as_ref()) > 5.0 { "ranged" } else { "melee" }
    }
}

const ALLOWED_TRANSMUTED_TYPES: [&str; 6] = ["acid", "cold", "fire", "lightning", "poison", "thunder"];
const METAMAGIC_CONDITIONS: [&str; 10] = [
    "metamagic-careful",
    "metamagic-distant",
    "metamagic-empowered",
    "metamagic-extended",
    "metamagic-heightened",
    "metamagic-quickened",
    "metamagic-seeking",
    "metamagic-subtle",
    "metamagic-transmuted",
    "metamagic-twinned",
];

/// `CastSpell` (16845–18832).
pub fn cast_spell(r: &mut Resolve<'_>) -> Step {
    let authoritative = js::truthy(r.command.get("server_authoritative")) || r.context.truthy("serverAuthoritativeCombat");
    if authoritative {
        return authoritative_cast(r);
    }
    let command = r.command.clone();
    let actor_id = js::s(command.get("actor_id"));
    let actor_targets = json!([command.get("actor_id").cloned().unwrap_or(Value::Null)]);
    if js::truthy(command.get("resource")) && js::truthy(command.get("cost")) {
        let resource = js::string(command.get("resource"));
        let pool = crate::core::resource_pool(&r.state, &actor_id, &resource, js::safe_int(command.get("max"), 0));
        let cost = js::safe_int(command.get("cost"), 0);
        if pool.current < cost {
            return Err(rule("Недостаточно ресурса для заклинания", "INSUFFICIENT_RESOURCE"));
        }
        let payload = json!({ "resource": resource, "amount": cost, "before": pool.current, "after": pool.current - cost, "max": pool.max });
        r.events.push(event_from(&command, "ResourceSpent", Some(payload), Some(&actor_targets)));
    }
    let name = command.get("name").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value))).unwrap_or_default();
    let payload = json!({ "spell_id": nn(command.get("spell_id")).cloned().unwrap_or(Value::Null), "name": name });
    r.events.push(event_from(&command, "SpellCast", Some(payload), None));
    if js::truthy(command.get("concentration")) {
        let truthy = |key: &str| command.get(key).filter(|value| js::truthy(Some(value)));
        let effect_id = match truthy("concentration_effect_id").or_else(|| truthy("spell_id")).or_else(|| truthy("name")) {
            Some(value) => js::string(Some(value)),
            None => (r.uuid)(),
        };
        let source = command_with_rules(&command, &[rule_ids::CONCENTRATION]);
        r.events.push(event_from(&source, "ConcentrationStarted", Some(json!({ "effect_id": effect_id })), Some(&actor_targets)));
    }
    Ok(())
}

/// Авторитетный путь `CastSpell` (16846–18821).
fn authoritative_cast(r: &mut Resolve<'_>) -> Step {
    let state = r.state.clone();
    let actor_id = js::s(r.command.get("actor_id"));
    let actor = sk_core::game::find_actor(&state, &actor_id).cloned();
    let from = crate::tactical_geometry::actor_point(&state, &actor_id);
    let ruleset_options = json!({ "rulesetId": state.get("ruleset_id").cloned().unwrap_or(Value::Null) });
    let raw_spell = if sk_combat_content::combat_spells::monster_spellcasting_for(actor.as_ref()).is_some() {
        sk_combat_content::combat_spells::monster_combat_spell_for(actor.as_ref(), r.command.get("spell_id"), Some(&ruleset_options))
    } else {
        sk_combat_content::combat_spells::combat_spell_for(actor.as_ref(), r.command.get("spell_id"), Some(&ruleset_options))
    };
    let spell = raw_spell.map(|spell| crate::spells::slots::with_spell_option_overrides(&spell, r.command.get("spell_option")));
    let spell = Executable::admit(spell, "заклинания")?;
    let uses_2014 = sk_core::game::uses_2014(&state);
    let spell_id_value = spell.get("id").cloned();
    if spell_id_value.as_ref().and_then(Value::as_str) == Some("resistance") && uses_2014 {
        let effect = format!("{}:{}", template(spell_id_value.as_ref()), template(r.command.get("command_id")));
        if let Some(command) = r.command.as_object_mut() {
            command.insert("concentration".into(), Value::Bool(true));
            command.insert("concentration_effect_id".into(), Value::String(effect));
        }
    }
    let combat = sk_core::game::combat(&state).clone();
    let combat_active = js::truthy(combat.get("active"));
    let actor_targets = json!([actor_id]);
    if !combat_active && field(&spell, "actionType").and_then(Value::as_str) == Some("long_cast") {
        let existing = at(sk_core::game::mechanics(&state).get("concentration"), &actor_id);
        if let Some(effect_id) = at(existing, "effect_id").filter(|value| js::truthy(Some(value))) {
            r.push_ruled(&[rule_ids::CONCENTRATION], "ConcentrationEnded", json!({ "reason": "long-cast-started", "effect_id": effect_id }), actor_targets.clone());
        }
        let minutes = crate::core::casting_time_minutes(field(&spell, "castingTime"));
        if minutes > 0.0 {
            let source = r.command_with_rules(&[rule_ids::RESOURCE]);
            r.append_world_time_consequences(&source, Some(&js::num(minutes)), Some(&json!("minute")), crate::resolve::world_time::TimeAdvanceOptions::default())?;
        }
    }
    let command = r.command.clone();
    let counterspell = if r.context.truthy("readiedRelease") || r.context.truthy("additionalBeam") { None } else { crate::reactions::counterspell_window_for(&state, &command, &spell) };
    if let Some(counterspell) = counterspell {
        r.events.push(counterspell);
        return Ok(());
    }
    if combat_active && !r.events.iter().any(|event| event.get("event_type").and_then(Value::as_str) == Some("ReactionWindowOpened")) {
        readied_spell_window(r, &state, &combat, &command, &actor_id);
    }
    let spell_ability = field(&spell, "spellcastingAbility").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value))).unwrap_or_else(|| "int".into());
    let spell_modifier = ability_modifier(at(at(actor.as_ref(), "abilities"), &spell_ability));
    let monster_spell = nn(field(&spell, "monsterSpell")).cloned();
    let spell_attack_modifier = match monster_spell.as_ref().filter(|value| js::truthy(Some(value))) {
        Some(monster) => js::number(monster.get("attackBonus")) as i64,
        None => sk_combat_content::combat_spells::hero_spell_attack_modifier(actor.as_ref(), &spell_ability),
    };
    let spell_save_dc = match monster_spell.as_ref().filter(|value| js::truthy(Some(value))) {
        Some(monster) => js::number(monster.get("saveDc")) as i64,
        None => 8 + spell_attack_modifier,
    };
    if let Some(usage) = command.get("monster_spell_use").filter(|value| js::truthy(Some(value))) {
        let hidden = crate::core::command_with(&command, "visibility", json!("gm_only"));
        let source = command_with_rules(&hidden, &[rule_ids::CONDITIONS]);
        let condition = format!("{}{}#{}", sk_combat_content::combat_spells::MONSTER_SPELL_USE_CONDITION_PREFIX, template(usage.get("spell_id")), template(usage.get("ordinal")));
        r.events.push(event_from(&source, "ConditionAdded", Some(json!({ "condition": condition, "duration": "until-long-rest", "source_actor": command.get("actor_id").cloned().unwrap_or(Value::Null) })), Some(&actor_targets)));
    }
    let spell_id = template(spell_id_value.as_ref());
    let is_shillelagh = spell_id_value.as_ref().and_then(Value::as_str) == Some(crate::combat::weapons::SHILLELAGH_CONDITION);
    let shillelagh_item = if is_shillelagh { crate::combat::weapons::combat_item_for_command(actor.as_ref(), command.get("item_id")).cloned() } else { None };
    let shillelagh_item_id = shillelagh_item.as_ref().map(|item| crate::combat::weapons::item_instance_key(Some(item)));
    let effect_id = format!("{spell_id}:{}", template(command.get("command_id")));
    let component_events = crate::spells::components::spell_component_cost_events(&state, &command, Some(&spell), &r.context)?;
    r.events.extend(component_events);
    let spent_slot_resource = if r.context.truthy("additionalBeam") || r.context.truthy("readiedRelease") {
        None
    } else {
        nn(command.get("spell_slot_resource")).or_else(|| field(&spell, "slotResource")).cloned()
    };
    if let Some(resource) = spent_slot_resource.as_ref().filter(|value| js::truthy(Some(value))) {
        let pool = crate::core::resource_pool(&state, &actor_id, &js::string(Some(resource)), 0);
        r.push_ruled(&[rule_ids::RESOURCE], "ResourceSpent", json!({ "resource": resource, "amount": 1, "before": pool.current, "after": pool.current - 1, "max": pool.max }), actor_targets.clone());
    }
    let previous = at(sk_core::game::mechanics(&state).get("concentration"), &actor_id).cloned();
    if js::truthy(field(&spell, "concentration")) && previous.as_ref().is_some_and(|value| js::truthy(Some(value))) {
        let previous_effect = previous.as_ref().and_then(|value| value.get("effect_id"));
        let mut payload = Map::new();
        payload.insert("reason".into(), json!("replaced"));
        put(&mut payload, "effect_id", previous_effect);
        r.push_ruled(&[rule_ids::CONCENTRATION], "ConcentrationEnded", Value::Object(payload), actor_targets.clone());
        let wanted = js::string(previous_effect);
        for summon in crate::normalize::summons::party_summons_for_expiry(&state) {
            let source = nn(summon.get("sourceEffectId")).or_else(|| nn(summon.get("source_effect_id")));
            if js::s(source) != wanted {
                continue;
            }
            r.push_ruled(
                &[rule_ids::CONCENTRATION],
                "SummonedCreatureDismissed",
                json!({ "reason": "concentration_replaced", "summon_lifecycle_version": crate::constants::SUMMON_LIFECYCLE_VERSION }),
                json!([actor_id_of(&summon)]),
            );
        }
    }
    let zone_only_cast = js::is_false(at(field(&spell, "createsAreaEffect"), "resolveOnCast"));
    let affected = if zone_only_cast { Vec::new() } else { crate::areas::shape::spell_targets_at(&state, &command, &spell) };
    let affected_ids: Vec<String> = affected.iter().map(actor_id_of).collect();
    let npc_affected = if zone_only_cast { Vec::new() } else { crate::areas::shape::npc_spell_targets_at(&state, &command, &spell) };
    let mut all_affected_ids: Vec<Value> = affected_ids.iter().cloned().map(Value::String).collect();
    all_affected_ids.extend(npc_affected.iter().map(|target| Value::String(js::string(target.npc.get("id")))));
    let wounded_target = affected.first().is_some_and(|target| sk_core::game::actor_hp(target) < crate::core::actor_max_hp(Some(target)));
    let base_damage = if wounded_target && js::truthy(field(&spell, "damageIfTargetWounded")) { field(&spell, "damageIfTargetWounded").cloned() } else { field(&spell, "damage").cloned() };
    let level = level_of(&spell);
    let kind = template(field(&spell, "kind"));
    let scaled = crate::spells::slots::scaled_spell_dice(Some(&with_fields(&spell, &[("damage", base_damage.clone())])), actor.as_ref(), command.get("slot_level"));
    let mut damage_expression = scaled.or_else(|| {
        (["attack", "save", "area-save", "damage", "area-damage"].contains(&kind.as_str()) && js::truthy(base_damage.as_ref())).then(|| Value::String(format!("{}d6", (level + 1).max(1))))
    });
    let actor_level = js::safe_int(at(actor.as_ref(), "level"), 1);
    if uses_2014
        && field(&spell, "level").and_then(Value::as_f64) == Some(0.0)
        && field(&spell, "spellcastingClass").and_then(Value::as_str) == Some("cleric")
        && crate::tables::character_class_key(actor.as_ref().unwrap_or(&Value::Null)).as_deref() == Some("cleric")
        && actor_level >= 8
        && sk_core::text::test(sk_core::re!(r"свет|знан|упоко|магии", "iu"), &sk_combat_content::combat_actions::normalized_combat_subclass_for(actor.as_ref()).unwrap_or_default())
        && js::truthy(damage_expression.as_ref())
    {
        let wisdom = ability_modifier(at(at(actor.as_ref(), "abilities"), "wis"));
        damage_expression = Some(Value::String(dice_expression(damage_expression.as_ref(), Some(&Value::from(wisdom)), 8)?));
    }
    if kind == "attack" && is_true(field(&spell, "damageAddsSpellcastingModifier")) && js::truthy(damage_expression.as_ref()) {
        let bonus = crate::spells::slots::spell_attack_damage_modifier(&spell, actor.as_ref());
        damage_expression = Some(Value::String(dice_expression(damage_expression.as_ref(), Some(&Value::from(bonus)), 6)?));
    }
    let metamagic = condition_ids_for(&state, &actor_id);
    let requested_transmuted = js::s(command.get("transmuted_damage_type"));
    let option_text = js::s(command.get("spell_option"));
    let selected_damage_type = (list_includes(field(&spell, "spellOptions"), &option_text) && ALLOWED_TRANSMUTED_TYPES.contains(&js::string(command.get("spell_option")).as_str()))
        .then(|| js::string(command.get("spell_option")));
    let damage_type = if metamagic.contains("metamagic-transmuted") && ALLOWED_TRANSMUTED_TYPES.contains(&requested_transmuted.as_str()) {
        Value::String(requested_transmuted.clone())
    } else if let Some(selected) = selected_damage_type.as_ref() {
        Value::String(selected.clone())
    } else {
        nn(field(&spell, "damageType")).or_else(|| nn(field(&spell, "damageTypes").and_then(Value::as_array).and_then(|list| list.first()))).cloned().unwrap_or_else(|| json!("force"))
    };
    let range = field(&spell, "range");
    let effective_range = if metamagic.contains("metamagic-distant") && js::number(range) > 0.0 { Some(js::num(js::number(range) * 2.0)) } else { range.cloned() };
    let effective_action_type = if metamagic.contains("metamagic-quickened") && field(&spell, "actionType").and_then(Value::as_str) == Some("action") {
        Some(json!("bonus_action"))
    } else {
        field(&spell, "actionType").cloned()
    };
    // Визуальная геометрия события (16987–16996).
    let target_kind = field(&spell, "target").and_then(Value::as_str);
    let source_point = if target_kind == Some("self") { from.map(point_json) } else { command.get("to").cloned() };
    let visual_gate = (target_kind == Some("point") && js::truthy(command.get("to"))) || (target_kind == Some("self") && ["area-save", "area-damage"].contains(&kind.as_str()) && from.is_some());
    let visual_target = if visual_gate {
        let x = js::number(at(source_point.as_ref(), "x"));
        let y = js::number(at(source_point.as_ref(), "y"));
        (crate::core::is_safe_integer_f64(x) && crate::core::is_safe_integer_f64(y)).then(|| Point::new(x, y))
    } else {
        None
    };
    let (visual_target_visible, visual_origin_visible) = match visual_target {
        Some(target) => {
            let cells = crate::tactical_geometry::tactical_cell_map(&state);
            let revealed = |point: Point| cells.get(&crate::tactical_geometry::key_of(point)).is_some_and(|cell| is_true(cell.get("revealed")));
            (revealed(target), from.is_some_and(revealed))
        }
        None => (false, false),
    };
    let spell_cast_event_id = format!("spell-cast:{}", slice_utf16(&template(command.get("command_id")), 100));
    let additional_or_readied = r.context.truthy("additionalBeam") || r.context.truthy("readiedRelease");
    let mut payload = Map::new();
    put(&mut payload, "spell_id", spell_id_value.as_ref());
    put(&mut payload, "name", field(&spell, "name"));
    put(&mut payload, "kind", field(&spell, "kind"));
    put(&mut payload, "action_type", effective_action_type.as_ref());
    if uses_2014 {
        payload.insert("spellcasting_2014_version".into(), json!(1));
    }
    if !uses_2014 && spent_slot_resource.as_ref().is_some_and(|value| js::truthy(Some(value))) {
        payload.insert("slot_spell_2024_version".into(), json!(1));
    }
    if additional_or_readied {
        payload.insert("economy_consumed".into(), Value::Bool(false));
    }
    put(&mut payload, "level", field(&spell, "level"));
    put(&mut payload, "slot_level", nn(command.get("slot_level")).or_else(|| field(&spell, "level")));
    put(&mut payload, "range_feet", effective_range.as_ref());
    payload.insert("concentration".into(), Value::Bool(js::truthy(field(&spell, "concentration"))));
    put(&mut payload, "source_url", field(&spell, "sourceUrl"));
    payload.insert("spell_option".into(), nn(command.get("spell_option")).cloned().unwrap_or(Value::Null));
    let cae = field(&spell, "createsAreaEffect");
    let no_damage_type = nn(field(&spell, "damage")).is_none()
        && nn(field(&spell, "damageType")).is_none()
        && !has_length(field(&spell, "damageTypes"))
        && !js::truthy(field(&spell, "bonusDamage"))
        && !js::truthy(at(cae, "damage"))
        && !js::truthy(at(field(&spell, "nextWeaponHit"), "damage"))
        && !js::truthy(at(field(&spell, "summon"), "damage"))
        && selected_damage_type.is_none();
    payload.insert("damage_type".into(), if no_damage_type { Value::Null } else { damage_type.clone() });
    if is_shillelagh {
        payload.insert("item_id".into(), nn(at(shillelagh_item.as_ref(), "id")).cloned().unwrap_or(Value::Null));
        payload.insert("item_instance_id".into(), shillelagh_item_id.clone().map(Value::String).unwrap_or(Value::Null));
        payload.insert("spellcasting_ability".into(), Value::String(spell_ability.clone()));
        payload.insert("magical_weapon".into(), Value::Bool(true));
    }
    if visual_target_visible {
        if let (true, Some(origin)) = (visual_origin_visible, from) {
            payload.insert("from".into(), point_json(origin));
        }
        let target = visual_target.unwrap_or(Point::new(0.0, 0.0));
        payload.insert("to".into(), point_json(target));
        if let Some(shape) = field(&spell, "areaShape").filter(|value| js::truthy(Some(value))) {
            payload.insert("area_shape".into(), shape.clone());
        }
        if let Some(origin) = field(&spell, "areaOrigin").filter(|value| js::truthy(Some(value))) {
            payload.insert("area_origin".into(), origin.clone());
        }
        if nn(field(&spell, "radius")).is_some() {
            payload.insert("radius_feet".into(), Value::from(js::safe_int(field(&spell, "radius"), 0).max(0)));
        }
        if nn(field(&spell, "areaSideFeet")).is_some() {
            payload.insert("area_side_feet".into(), Value::from(js::safe_int(field(&spell, "areaSideFeet"), 0).max(0)));
        }
        if crate::areas::shape::circular_spell_geometry(&spell) {
            payload.insert("area_geometry_version".into(), json!(sk_geometry::circular_area_geometry::CIRCULAR_AREA_GEOMETRY_VERSION));
            payload.insert("area_grid_origin".into(), sk_geometry::circular_area_geometry::grid_origin_for_target_cell(target).to_value());
        }
    }
    let cast_targets = Value::Array(all_affected_ids);
    let explicit_targets = cast_targets.as_array().is_some_and(|ids| !ids.is_empty()).then_some(&cast_targets);
    let mut cast_event = event_from(&command, "SpellCast", Some(Value::Object(payload)), explicit_targets);
    cast_event["event_id"] = Value::String(spell_cast_event_id.clone());
    r.events.push(cast_event);
    if is_shillelagh {
        let removal = crate::combat::weapons::shillelagh_removal_events(&state, &command, crate::combat::weapons::ShillelaghRemoval { item_key: None, exclude_item_key: None, reason: Some("recast") });
        r.events.extend(removal);
    }
    for condition in METAMAGIC_CONDITIONS {
        if metamagic.contains(condition) {
            r.push_ruled(&[rule_ids::CONDITIONS], "ConditionRemoved", json!({ "condition": condition }), actor_targets.clone());
        }
    }
    if js::truthy(field(&spell, "concentration")) {
        r.push_ruled(&[rule_ids::CONCENTRATION], "ConcentrationStarted", json!({ "effect_id": effect_id }), actor_targets.clone());
    }
    if js::truthy(field(&spell, "nextWeaponHit")) {
        let duration = if js::truthy(field(&spell, "concentration")) {
            "concentration".to_string()
        } else if js::truthy(field(&spell, "durationRounds")) {
            format!("rounds:{}", template(field(&spell, "durationRounds")))
        } else {
            "until-used".to_string()
        };
        let mut payload = Map::new();
        payload.insert("condition".into(), Value::String(format!("next-weapon-hit:{spell_id}")));
        payload.insert("duration".into(), Value::String(duration));
        payload.insert("source_actor".into(), command.get("actor_id").cloned().unwrap_or(Value::Null));
        payload.insert("effect_id".into(), Value::String(effect_id.clone()));
        put(&mut payload, "spell_id", spell_id_value.as_ref());
        payload.insert("save_dc".into(), Value::from(spell_save_dc));
        payload.insert("slot_level".into(), Value::from(slot_level_of(&spell, &command)));
        r.push_ruled(&[rule_ids::CONDITIONS], "ConditionAdded", Value::Object(payload), actor_targets.clone());
    }
    if js::truthy(field(&spell, "grantsDashOnCast")) {
        let movement_bonus = crate::speed::effective_speed_feet(&state, actor.as_ref().unwrap_or(&Value::Null), &actor_id);
        let mut payload = Map::new();
        payload.insert("action_id".into(), Value::String(format!("{spell_id}:initial-dash")));
        put(&mut payload, "name", field(&spell, "name"));
        payload.insert("action_type".into(), json!("free"));
        payload.insert("movement_bonus".into(), Value::from(movement_bonus));
        payload.insert("dash_count".into(), json!(1));
        payload.insert("movement_contract_version".into(), json!(2));
        r.push_ruled(&[rule_ids::TURNS], "CombatActionUsed", Value::Object(payload), actor_targets.clone());
    }
    let spell_area_center = if js::truthy(cae) {
        if field(&spell, "areaOrigin").and_then(Value::as_str) == Some("self") || target_kind == Some("self") {
            Some(point_value(crate::tactical_geometry::actor_point(&state, &actor_id)))
        } else {
            command.get("to").cloned()
        }
    } else {
        None
    };
    let mut cast = Cast {
        command: command.clone(),
        actor_id: actor_id.clone(),
        actor,
        spell: spell.clone(),
        spell_ability,
        spell_modifier,
        spell_attack_modifier,
        spell_save_dc,
        shillelagh_item_id,
        effect_id,
        affected,
        npc_affected,
        damage_expression,
        metamagic,
        damage_type,
        effective_range,
        spell_cast_event_id,
    };
    let center = spell_area_center.filter(|value| js::truthy(Some(value)));
    if js::truthy(cae) {
        if let Some(center) = center.as_ref() {
            spell_area_created(r, &state, &cast, center)?;
        }
    }
    if js::string(Some(&cast.damage_type)) == "fire" {
        burn_flammable_areas(r, &state, &cast, if js::truthy(cae) { center.as_ref() } else { None })?;
    }
    dispatch_kind(r, &mut cast)?;
    super::summon::additional_beams(r, &cast)
}

/// Ветка по виду заклинания (17242–18778).
fn dispatch_kind(r: &mut Resolve<'_>, cast: &mut Cast) -> Step {
    let spell = cast.spell.clone();
    let kind = template(field(&spell, "kind"));
    let id = field(&spell, "id").and_then(Value::as_str).unwrap_or("");
    if is_true(field(&spell, "automaticHit")) && js::truthy(field(&spell, "projectileCount")) {
        return super::attack::magic_missile(r, cast);
    }
    if js::truthy(field(&spell, "hitPointPoolDice")) {
        return super::attack::hit_point_pool(r, cast);
    }
    if kind == "attack" {
        return super::attack::spell_attack(r, cast);
    }
    if ["save", "area-save", "debuff"].contains(&kind.as_str()) {
        return super::save::saving_throw_spell(r, cast);
    }
    if ["damage", "area-damage"].contains(&kind.as_str()) {
        return super::save::damage_spell(r, cast);
    }
    if kind == "healing" && js::truthy(field(&spell, "selfDamage")) {
        return super::heal_buff::life_transference(r, cast);
    }
    if kind == "healing" {
        return super::heal_buff::healing(r, cast);
    }
    if is_true(field(&spell, "unlocksTarget")) {
        return super::heal_buff::knock(r, cast);
    }
    if is_true(field(&spell, "dispelsMagic")) {
        return super::heal_buff::dispel_magic(r, cast);
    }
    if id == "borrowed-knowledge" || id == "skill-empowerment" {
        return super::heal_buff::skill_buff(r, cast);
    }
    if ["buff", "utility"].contains(&kind.as_str()) {
        return super::heal_buff::buff(r, cast);
    }
    if kind == "teleport" {
        return super::utility::teleport(r, cast);
    }
    if kind == "summon" {
        return super::summon::summon(r, cast);
    }
    Ok(())
}

/// Заготовленная атака на творящего заклинание (16887–16911).
fn readied_spell_window(r: &mut Resolve<'_>, state: &Value, combat: &Value, command: &Value, actor_id: &str) {
    let caster_is_enemy = sk_core::game::is_enemy_actor(state, actor_id);
    let mut order: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (index, entry) in items(combat.get("initiative")).iter().enumerate() {
        order.insert(js::string(entry.get("actor_id")), index);
    }
    let blocking = crate::reactions::opportunity_blocking_conditions();
    let readied = crate::pause::object_entries(nn(combat.get("readied")));
    let mut candidates: Vec<(String, Value)> = readied
        .into_iter()
        .filter(|(ready_id, entry)| {
            js::string(at(Some(entry), "trigger")) == "enemy-casts-spell"
                && ready_id != actor_id
                && sk_core::game::is_enemy_actor(state, ready_id) != caster_is_enemy
                && living(sk_core::game::find_actor(state, ready_id))
                && !js::is_false(at(at(combat.get("action_economy"), ready_id), "reaction"))
                && {
                    let ids = condition_ids_for(state, ready_id);
                    !blocking.iter().any(|condition| ids.contains(*condition))
                }
        })
        .filter(|(ready_id, entry)| js::truthy(at(Some(entry), "spell_id")) || crate::targets::distance_between_actors(state, ready_id, actor_id).is_none_or(|distance| distance <= 5.0))
        .collect();
    let rank = |id: &str| order.get(id).map_or(9_007_199_254_740_991_i64, |index| *index as i64);
    candidates.sort_by(|(left, _), (right, _)| rank(left).cmp(&rank(right)).then_with(|| sk_core::text::locale_compare(left, right)));
    let Some((ready_id, entry)) = candidates.into_iter().next() else { return };
    let option = crate::core::readied_option_for(Some(&entry), None);
    let reasoned = crate::core::readied_option_for(Some(&entry), Some("Враг начал творить заклинание"));
    let payload = json!({
        "id": format!("reaction:{}:readied", template(command.get("command_id"))),
        "trigger": "readied",
        "readied_trigger": "enemy-casts-spell",
        "actor_id": ready_id,
        "source_actor_id": command.get("actor_id").cloned().unwrap_or(Value::Null),
        "target_id": command.get("actor_id").cloned().unwrap_or(Value::Null),
        "action_ids": [option.get("id").cloned().unwrap_or(Value::Null)],
        "action_options": [reasoned],
        "damage": null,
    });
    r.push_ruled(&[rule_ids::REACTION], "ReactionWindowOpened", payload, json!([ready_id]));
}

/// Поля области для пересечения: `{ center, ...circularAreaMetadata, radius_feet,
/// area_shape, area_side_feet? }`.
fn area_probe(spell: &Value, center: &Value, minimum_radius: i64) -> Value {
    let mut probe = Map::new();
    probe.insert("center".into(), center.clone());
    extend(&mut probe, crate::areas::shape::circular_area_metadata(spell, Some(center)));
    probe.insert("radius_feet".into(), Value::from(js::safe_int(field(spell, "radius"), 5).max(minimum_radius)));
    probe.insert("area_shape".into(), nn(field(spell, "areaShape")).cloned().unwrap_or_else(|| json!("sphere")));
    if nn(field(spell, "areaSideFeet")).is_some() {
        probe.insert("area_side_feet".into(), Value::from(js::safe_int(field(spell, "areaSideFeet"), 0).max(0)));
    }
    Value::Object(probe)
}

/// `SpellAreaCreated` длящейся области заклинания и гашение пламени (17064–17170).
fn spell_area_created(r: &mut Resolve<'_>, state: &Value, cast: &Cast, center: &Value) -> Step {
    let spell = &cast.spell;
    let command = &cast.command;
    let cae = field(spell, "createsAreaEffect").cloned().unwrap_or(Value::Null);
    let cae_field = |key: &str| at(Some(&cae), key);
    let uses_2014 = sk_core::game::uses_2014(state);
    let level = level_of(spell);
    let save_ability = if cae.as_object().is_some_and(|map| map.contains_key("saveAbility")) { cae_field("saveAbility") } else { field(spell, "saveAbility") };
    let extra_levels = Value::from((js::safe_int(command.get("slot_level"), level) - level).max(0));
    let area_damage = if js::truthy(cae_field("damage")) && is_true(cae_field("cantripScaling")) {
        let damage = Value::String(template(cae_field("damage")));
        Some(crate::spells::slots::scaled_spell_dice(Some(&with_fields(spell, &[("damage", Some(damage.clone()))])), cast.actor.as_ref(), command.get("slot_level")).unwrap_or(damage))
    } else if js::truthy(cae_field("damage")) {
        let per_level = Value::from(js::safe_int(nn(cae_field("upcastDicePerLevel")).or_else(|| field(spell, "upcastDicePerLevel")), 0));
        Some(Value::String(crate::spells::slots::scaled_dice_expression(&template(cae_field("damage")), Some(&extra_levels), Some(&per_level), None)))
    } else {
        None
    };
    let healing = if js::truthy(cae_field("healing")) {
        let per_level = Value::from(js::safe_int(cae_field("upcastHealingDicePerLevel"), 0));
        Value::String(crate::spells::slots::scaled_dice_expression(&template(cae_field("healing")), Some(&extra_levels), Some(&per_level), None))
    } else {
        Value::Null
    };
    let mut effect = Map::new();
    effect.insert("id".into(), Value::String(cast.effect_id.clone()));
    effect.insert("effect_id".into(), Value::String(cast.effect_id.clone()));
    put(&mut effect, "spell_id", field(spell, "id"));
    effect.insert("source_actor".into(), command.get("actor_id").cloned().unwrap_or(Value::Null));
    if uses_2014 {
        effect.insert("spell_level_version".into(), json!(1));
        effect.insert("slot_level".into(), Value::from(slot_level_of(spell, command)));
    }
    effect.insert("center".into(), json!({ "x": js::num(js::number(center.get("x"))), "y": js::num(js::number(center.get("y"))) }));
    extend(&mut effect, crate::areas::shape::circular_area_metadata(spell, Some(center)));
    effect.insert("radius_feet".into(), Value::from(js::safe_int(field(spell, "radius"), 5).max(0)));
    effect.insert("area_shape".into(), nn(field(spell, "areaShape")).cloned().unwrap_or_else(|| json!("sphere")));
    if nn(field(spell, "areaSideFeet")).is_some() {
        effect.insert("area_side_feet".into(), Value::from(js::safe_int(field(spell, "areaSideFeet"), 0).max(0)));
    }
    effect.insert("difficult_terrain".into(), Value::Bool(is_true(cae_field("difficultTerrain"))));
    let multiplier = js::safe_int(cae_field("movementCostMultiplier"), 0);
    if multiplier > 2 {
        effect.insert("movement_cost_multiplier".into(), Value::from(multiplier));
    }
    effect.insert("trigger_on_enter".into(), Value::Bool(is_true(cae_field("triggerOnEnter"))));
    effect.insert("trigger_on_turn_start".into(), Value::Bool(is_true(cae_field("triggerOnTurnStart"))));
    effect.insert("trigger_on_turn_end".into(), Value::Bool(is_true(cae_field("triggerOnTurnEnd"))));
    effect.insert("save_ability".into(), nn(save_ability).cloned().unwrap_or(Value::Null));
    effect.insert("save_dc".into(), Value::from(cast.spell_save_dc));
    effect.insert("condition".into(), nn(cae_field("condition")).cloned().unwrap_or(Value::Null));
    if js::truthy(cae_field("conditionDuration")) {
        effect.insert("condition_duration".into(), Value::String(template(cae_field("conditionDuration"))));
    }
    if is_true(cae_field("spendActionOnFail")) {
        effect.insert("spend_action_on_fail".into(), Value::Bool(true));
    }
    if js::truthy(cae_field("failedActionName")) {
        effect.insert("failed_action_name".into(), Value::String(template(cae_field("failedActionName"))));
    }
    if js::truthy(cae_field("saveDamageType")) {
        effect.insert("save_damage_type".into(), Value::String(template(cae_field("saveDamageType"))));
    }
    for (source, target) in [("requiresBreathing", "requires_breathing"), ("requiresFullFootprint", "requires_full_footprint"), ("concentrationSaveOnTurnStart", "concentration_save_on_turn_start")] {
        if is_true(cae_field(source)) {
            effect.insert(target.into(), Value::Bool(true));
        }
    }
    effect.insert("damage".into(), area_damage.unwrap_or(Value::Null));
    effect.insert("healing".into(), healing);
    effect.insert("damage_type".into(), nn(cae_field("damageType")).or_else(|| nn(field(spell, "damageType"))).cloned().unwrap_or(Value::Null));
    effect.insert("half_on_save".into(), Value::Bool(is_true(cae_field("halfOnSave"))));
    effect.insert("follows_source".into(), Value::Bool(is_true(cae_field("followsSource"))));
    if let Some(flammable) = cae_field("flammable").filter(|value| js::truthy(Some(value))) {
        effect.insert("flammable".into(), flammable.clone());
    }
    if is_true(cae_field("dousesFlames")) {
        effect.insert("douses_flames".into(), Value::Bool(true));
    }
    if is_true(cae_field("openFlame")) {
        effect.insert("open_flame".into(), Value::Bool(true));
    }
    if field(spell, "areaShape").and_then(Value::as_str) == Some("line") {
        let cells = crate::areas::shape::wall_cells(state, command, spell);
        effect.insert("cells".into(), crate::areas::shape::cells_json(&cells));
    }
    if is_true(cae_field("oncePerTurn")) {
        effect.insert("once_per_turn".into(), Value::Bool(true));
    }
    if is_true(cae_field("skipAlreadyAffected")) {
        effect.insert("skip_already_affected".into(), Value::Bool(true));
    }
    let push_feet = js::safe_int(cae_field("pushFeet"), 0);
    if push_feet > 0 {
        effect.insert("push_feet".into(), Value::from(push_feet));
    }
    if let Some(profile) = cae_field("turnStartProfile").filter(|value| js::truthy(Some(value))) {
        let mut entry = Map::new();
        entry.insert("damage".into(), if js::truthy(profile.get("damage")) { Value::String(template(profile.get("damage"))) } else { Value::Null });
        entry.insert("damage_type".into(), nn(profile.get("damageType")).cloned().unwrap_or(Value::Null));
        entry.insert("save_ability".into(), nn(profile.get("saveAbility")).cloned().unwrap_or(Value::Null));
        entry.insert("condition".into(), nn(profile.get("condition")).cloned().unwrap_or(Value::Null));
        if js::truthy(profile.get("conditionDuration")) {
            entry.insert("condition_duration".into(), Value::String(template(profile.get("conditionDuration"))));
        }
        effect.insert("turn_start_profile".into(), Value::Object(entry));
    }
    if is_true(cae_field("sparesAllies")) {
        effect.insert("unaffected_actor_ids".into(), js::strings_value(crate::areas::shape::area_caster_side_ids(state, &cast.actor_id)));
    }
    if is_true(cae_field("sparesSource")) && !is_true(cae_field("sparesAllies")) {
        effect.insert("unaffected_actor_ids".into(), json!([template(command.get("actor_id"))]));
    }
    effect.insert("concentration".into(), Value::Bool(js::truthy(field(spell, "concentration"))));
    let expires = if is_true(cae_field("permanent")) {
        9_007_199_254_740_991_i64
    } else {
        js::safe_int(sk_core::game::combat(state).get("round"), 1) + js::safe_int(field(spell, "durationRounds"), 1).max(1)
    };
    effect.insert("expires_round".into(), Value::from(expires));
    r.push_ruled(&[rule_ids::CONDITIONS], "SpellAreaCreated", json!({ "effect": Value::Object(effect) }), json!([]));
    if is_true(cae_field("dousesFlames")) {
        let incoming = area_probe(spell, center, 0);
        for burning in items(sk_core::game::mechanics(state).get("active_effects")) {
            if !is_true(burning.get("open_flame")) || !crate::areas::shape::areas_overlap(state, &burning, &incoming) {
                continue;
            }
            let mut payload = Map::new();
            payload.insert("effect_id".into(), Value::String(js::string(nn(burning.get("effect_id")).or_else(|| burning.get("id")))));
            put(&mut payload, "spell_id", burning.get("spell_id"));
            payload.insert("reason".into(), json!("doused"));
            r.push_ruled(&[rule_ids::CONDITIONS], "SpellAreaRemoved", Value::Object(payload), json!([]));
        }
    }
    Ok(())
}

/// Огонь выжигает паутину и поджигает масло (17175–17240).
fn burn_flammable_areas(r: &mut Resolve<'_>, state: &Value, cast: &Cast, area_center: Option<&Value>) -> Step {
    let spell = &cast.spell;
    let command = &cast.command;
    let impact = if let Some(center) = area_center {
        Some(area_probe(spell, center, 0))
    } else if let Some(to) = command.get("to").filter(|value| js::truthy(Some(value))) {
        Some(area_probe(spell, to, 5))
    } else {
        cast.affected.first().map(|first| json!({ "center": point_value(crate::tactical_geometry::actor_point(state, &actor_id_of(first))), "radius_feet": 5, "area_shape": "sphere" }))
    };
    let Some(impact) = impact else { return Ok(()) };
    let webs: Vec<Value> = items(sk_core::game::mechanics(state).get("active_effects")).into_iter().filter(|candidate| js::truthy(candidate.get("flammable")) && crate::areas::shape::areas_overlap(state, candidate, &impact)).collect();
    let round = js::safe_int(sk_core::game::combat(state).get("round"), 1);
    for web in webs {
        let web_effect_id = js::string(nn(web.get("effect_id")).or_else(|| web.get("id")));
        let mut removed = Map::new();
        removed.insert("effect_id".into(), Value::String(web_effect_id.clone()));
        put(&mut removed, "spell_id", web.get("spell_id"));
        removed.insert("reason".into(), json!("burned-away"));
        r.push_ruled(&[rule_ids::CONDITIONS], "SpellAreaRemoved", Value::Object(removed), json!([]));
        let ignites = web.get("ignites_into").filter(|value| js::truthy(Some(value)));
        if let Some(ignites) = ignites {
            let burning_id = format!("{web_effect_id}:burning");
            let mut effect = spread_value(Some(&web));
            effect.insert("id".into(), Value::String(burning_id.clone()));
            effect.insert("effect_id".into(), Value::String(burning_id));
            effect.insert("spell_id".into(), Value::String(format!("{}:burning", js::string(web.get("spell_id")))));
            effect.shift_remove("flammable");
            effect.shift_remove("ignites_into");
            effect.insert("open_flame".into(), Value::Bool(true));
            effect.insert("trigger_on_enter".into(), Value::Bool(true));
            effect.insert("trigger_on_turn_end".into(), Value::Bool(true));
            effect.insert("save_ability".into(), Value::Null);
            effect.insert("damage".into(), Value::Null);
            effect.insert("damage_amount".into(), Value::from(js::safe_int(ignites.get("damage_amount"), 5)));
            effect.insert("damage_type".into(), Value::String(js::string(Some(nn(ignites.get("damage_type")).unwrap_or(&json!("fire"))))));
            effect.insert("half_on_save".into(), Value::Bool(false));
            effect.insert("expires_round".into(), Value::from(round + js::safe_int(ignites.get("rounds"), 2).max(1)));
            r.push_ruled(&[rule_ids::CONDITIONS], "SpellAreaCreated", json!({ "effect": Value::Object(effect) }), json!([]));
        }
        let flammable = web.get("flammable");
        let burn_expression = if js::truthy(at(flammable, "damage")) {
            Some(template(at(flammable, "damage")))
        } else if ignites.is_some() {
            None
        } else {
            Some("2d4".to_string())
        };
        let mut burn_state = fold(state, &r.events)?;
        let Some(expression) = burn_expression else { continue };
        let caught: Vec<Value> = sk_core::game::list_actors(&burn_state)
            .into_iter()
            .filter(|candidate| sk_core::game::is_living_actor(candidate) && crate::areas::shape::position_in_effect(&burn_state, crate::tactical_geometry::actor_point(&burn_state, &actor_id_of(candidate)), &web, Some(candidate)))
            .cloned()
            .collect();
        let damage_type = Value::String(js::string(Some(nn(at(flammable, "damageType")).unwrap_or(&json!("fire")))));
        for candidate in caught {
            let caught_id = actor_id_of(&candidate);
            let roll = r.spell_roll(Value::String(expression.clone()), &format!("spell_area_burn:{}", template(web.get("spell_id"))))?;
            r.rolls.push(roll.clone());
            r.push_die(roll.clone());
            let payload = r.resolve_damage_payload(&burn_state, &caught_id, roll.get("total").cloned().unwrap_or(Value::Null), &damage_type, None, None)?;
            let mut extra = Map::new();
            put(&mut extra, "spell_id", web.get("spell_id"));
            extra.insert("area_burned".into(), Value::Bool(true));
            let burn_event = event_from(&command_with_rules(command, &[rule_ids::DAMAGE]), "DamageApplied", Some(payload_with(&payload, Value::Object(extra))), Some(&json!([caught_id])));
            r.events.push(burn_event.clone());
            burn_state = apply_game_event(&burn_state, &burn_event)?;
            if hp_after_zero(&payload) {
                r.push_zero_hp(&burn_state, &caught_id, &payload, false);
            }
        }
    }
    Ok(())
}

//! Ветки редьюсера `applyGameEventCurrent`: Герой: выбор заклинаний и умений, броски характеристик и богатства, уровень и импорт, награды, опыт и вехи. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 26831–26847, 26848–26890, 26891–26893, 26894–26896, 26898–26938, 26939–26943, 26979–26993, 26994–27009. Таблица меток — `reduce/table.rs`
//! (Р0). Перенося ветку, уберите её метки из [`UNPORTED`] этого файла.
//!
//! Лист героя, выборы и уровень — `character-lifecycle` (крейт
//! `sk-character`), дележ награды — `encounter-rewards` (там же).

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};
use sk_character::character_lifecycle::{
    apply_character_lifecycle_event, character_creation_choices_complete, character_creation_target_level, class_resource_plan, derive_character_sheet,
};
use sk_core::game::{actor_id, mechanics_mut, replace_actor};
use sk_core::js::{self, s, safe_int};
use sk_core::text::head;
use sk_core::Event;

use super::items::{class_resource_options, lifecycle_error, module_error, put_defined, refresh_player_derived_state, ruleset_options, sheet_value};
use super::social::{event_value, target_value};
use super::world::type_error;
use super::{target_of, Reduced};
use crate::core::unique_strings;

/// Метки событий этого файла, чьи ветки ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[];

/// `MILESTONES_PER_LEVEL`.
pub const MILESTONES_PER_LEVEL: i64 = 3;

/// `String(target)`: цель события строкой (`targets[0] ?? event.actor_id`;
/// без обоих — `"null"`).
fn target_key(event: &Event) -> String {
    js::string(Some(&target_value(event)))
}

/// `replaceActor(state, target, …)`: без цели (`null`) — ни одна карточка
/// не совпадает (`actorId` всегда строка).
fn replace_target(state: &mut Value, event: &Event, update: impl FnMut(&mut Value)) {
    if let Value::String(target) = target_value(event) {
        replace_actor(state, &target, update);
    }
}

/// Номер героя в `state.players` по `actorId(candidate) === String(target)`.
fn player_index(state: &Value, key: &str) -> Option<usize> {
    state.get("players").and_then(Value::as_array)?.iter().position(|candidate| actor_id(candidate) == key)
}

/// Опции с `rulesetId: state.ruleset_id` (и, при `extra`, ещё полями).
fn options_with_ruleset(state: &Value, extra: Option<&Value>) -> Value {
    let mut options = ruleset_options(state);
    if let (Some(Value::Object(extra)), Some(map)) = (extra, options.as_object_mut()) {
        for (key, value) in extra {
            map.insert(key.clone(), value.clone());
        }
    }
    options
}

/// Поэтапное создание закончено: `characterSetupStage === 'leveling'`,
/// уровень не ниже стартового и все выборы сделаны — флаг снимается на
/// месте, стадия удаляется. Порядок проверок (и их отказы) — как в JS.
fn finish_leveling_stage(state: &mut Value, key: &str) -> Reduced {
    let Some(index) = player_index(state, key) else { return Ok(()) };
    let actor = &state["players"][index];
    if actor.get("characterSetupStage").and_then(Value::as_str) != Some("leveling") {
        return Ok(());
    }
    let target_level = character_creation_target_level(Some(state)).map_err(lifecycle_error)?;
    if !(js::number(actor.get("level")) >= target_level as f64) {
        return Ok(());
    }
    if !character_creation_choices_complete(Some(actor), Some(&ruleset_options(state))).map_err(lifecycle_error)? {
        return Ok(());
    }
    if let Some(map) = state["players"][index].as_object_mut() {
        map.insert("characterSetupRequired".into(), Value::Bool(false));
        map.shift_remove("characterSetupStage");
    }
    Ok(())
}

/// `SpellSelectionsUpdated` (26831–26847).
pub(super) fn spell_selections_updated(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    let known = js::strings_value(unique_strings(payload.get("known_spell_ids")));
    let prepared = js::strings_value(unique_strings(payload.get("prepared_spell_ids")));
    replace_target(state, event, |actor| {
        if let Some(map) = actor.as_object_mut() {
            map.insert("knownSpellIds".into(), known.clone());
            map.insert("preparedSpellIds".into(), prepared.clone());
        }
    });
    let key = target_key(event);
    finish_leveling_stage(state, &key)?;
    refresh_player_derived_state(state, &[key])
}

/// `CharacterChoicesUpdated` (26848–26890).
pub(super) fn character_choices_updated(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    let field = |key: &str| payload.get(key);
    let schema_2 = js::number(field("schema_version")) >= 2.0;
    let mut patch = Map::new();
    patch.insert("subclass".into(), Value::String(s(field("subclass"))));
    patch.insert("classSkillProficiencies".into(), js::strings_value(unique_strings(field("class_skill_proficiencies"))));
    patch.insert("selectedFeatureIds".into(), js::strings_value(unique_strings(field("selected_feature_ids"))));
    if js::is_plain(field("ability_score_increases")) {
        patch.insert("abilityScoreIncreases".into(), field("ability_score_increases").cloned().unwrap_or(Value::Null));
    }
    if schema_2 && js::is_plain(field("level_feats")) {
        patch.insert("levelFeats".into(), field("level_feats").cloned().unwrap_or(Value::Null));
    }
    if js::is_plain(field("abilities_after")) {
        patch.insert("abilities".into(), field("abilities_after").cloned().unwrap_or(Value::Null));
    }
    if schema_2 && js::is_plain(field("creation_benefits")) {
        patch.insert("creationBenefits".into(), field("creation_benefits").cloned().unwrap_or(Value::Null));
    }
    if schema_2 && matches!(field("creation_skill_proficiencies"), Some(Value::Array(_))) {
        patch.insert("creationSkillProficiencies".into(), js::strings_value(unique_strings(field("creation_skill_proficiencies"))));
    }
    if schema_2 && matches!(field("creation_spell_grants"), Some(Value::Array(_))) {
        patch.insert("creationSpellGrants".into(), field("creation_spell_grants").cloned().unwrap_or(Value::Null));
    }
    replace_target(state, event, |actor| {
        if let Some(map) = actor.as_object_mut() {
            for (key, value) in &patch {
                map.insert(key.clone(), value.clone());
            }
        }
    });
    let key = target_key(event);
    // `payload.creation_benefits && typeof … === 'object'`: массив тоже годится.
    let benefits = matches!(field("creation_benefits"), Some(Value::Object(_) | Value::Array(_)));
    if let Some(index) = player_index(state, &key).filter(|_| schema_2 && benefits) {
        let options = options_with_ruleset(state, Some(&class_resource_options(state)));
        // `try { … } catch {}`: отказ вывода листа хиты не трогает.
        if let Ok(sheet) = derive_character_sheet(Some(&state["players"][index]), Some(&options)) {
            if let Ok(Some(maximum)) = sheet_value(&sheet, "hit_points") {
                apply_sheet_hit_points(state, &key, &maximum);
            }
        }
    }
    finish_leveling_stage(state, &key)?;
    refresh_player_derived_state(state, &[key])
}

/// `{ ...candidate, maxHp: max, hp: Math.min(Math.max(0, safeInteger(hp, 0)), max) }`
/// у всех героев с этим id.
fn apply_sheet_hit_points(state: &mut Value, key: &str, maximum: &Value) {
    let Some(players) = state.get_mut("players").and_then(Value::as_array_mut) else { return };
    for candidate in players.iter_mut() {
        if actor_id(candidate) != key {
            continue;
        }
        let current = safe_int(candidate.get("hp"), 0).max(0) as f64;
        let limit = js::number(Some(maximum));
        // `Math.min(x, NaN)` — `NaN` (в JSON — `null`).
        let hp = if limit.is_nan() { Value::Null } else { js::num(current.min(limit)) };
        if let Some(map) = candidate.as_object_mut() {
            map.insert("maxHp".into(), maximum.clone());
            map.insert("hp".into(), hp);
        }
    }
}

/// `characterCreationRolls: { ...actor.characterCreationRolls, [key]: clone(payload) }`.
fn record_creation_roll(state: &mut Value, event: &Event, key: &str) -> Reduced {
    let target = target_of(event);
    let payload = event.payload.clone();
    replace_actor(state, &target, |actor| {
        let mut rolls = crate::core::spread_value(actor.get("characterCreationRolls"));
        rolls.insert(key.into(), payload.clone());
        if let Some(map) = actor.as_object_mut() {
            map.insert("characterCreationRolls".into(), Value::Object(rolls));
        }
    });
    Ok(())
}

/// `CharacterAbilitiesRolled` (26891–26893).
pub(super) fn character_abilities_rolled(state: &mut Value, event: &Event) -> Reduced {
    record_creation_roll(state, event, "abilities")
}

/// `CharacterWealthRolled` (26894–26896).
pub(super) fn character_wealth_rolled(state: &mut Value, event: &Event) -> Reduced {
    record_creation_roll(state, event, "wealth")
}

/// `CharacterLeveledUp`, `CharacterImported` (26898–26938).
pub(super) fn character_lifecycle_event(state: &mut Value, event: &Event) -> Reduced {
    let next = apply_character_lifecycle_event(state, &event_value(event)).map_err(lifecycle_error)?;
    state["players"] = next.get("players").cloned().unwrap_or(Value::Null);
    let payload = &event.payload;
    if event.event_type == "CharacterLeveledUp" && payload.get("progression_source").and_then(Value::as_str) == Some("milestone") {
        spend_milestones(state)?;
    }
    let key = target_key(event);
    let Some(index) = player_index(state, &key) else { return Ok(()) };
    let options = class_resource_options(state);
    let sheet = derive_character_sheet(Some(&state["players"][index]), Some(&options)).map_err(lifecycle_error)?;
    let mut players = state.get("players").and_then(Value::as_array).cloned().unwrap_or_default();
    for actor in players.iter_mut() {
        if actor_id(actor) != key {
            continue;
        }
        let armor = sheet_value(&sheet, "armor_class")?;
        let speed = sheet_value(&sheet, "speed")?;
        let mut map = actor.as_object().cloned().unwrap_or_default();
        put_defined(&mut map, "proficiency", sheet.get("proficiency_bonus").cloned());
        put_defined(&mut map, "armor", armor);
        put_defined(&mut map, "speed", speed);
        // Лист, заклинания и действия — пустые слоты в порядке JS (урок 2).
        for field in [crate::derived::CHARACTER_SHEET, crate::derived::COMBAT_SPELLS, crate::derived::COMBAT_ACTIONS] {
            map.insert(field.into(), Value::Null);
        }
        *actor = Value::Object(map);
    }
    state["players"] = Value::Array(players);
    let Some(index) = player_index(state, &key) else { return Ok(()) };
    let class_resources_2024 = sk_combat_content::combat_actions::class_resource_options_for(Some(state)).class_resources_2024;
    let plan = class_resource_plan(Some(&state["players"][index]), class_resources_2024);
    let resources = match sk_core::game::mechanics(state).get("resources") {
        Some(Value::Object(all)) => all.get(&key).filter(|value| !value.is_null()).cloned(),
        Some(Value::Array(_)) => None,
        _ => return Err(type_error("Cannot read properties of undefined (reading 'resources')")),
    };
    let grants_growth = safe_int(payload.get("resource_grant_version"), 0) >= 1;
    let mut next = Map::new();
    if let Some(Value::Object(maximums)) = plan.get("maximums") {
        for (resource, maximum) in js::entries(maximums) {
            let maximum_number = js::number(Some(maximum));
            let previous = resources.as_ref().and_then(|resources| resources.get(resource.as_str())).filter(|value| !value.is_null());
            let wanted = if grants_growth && js::truthy(previous) {
                let max_before = safe_int(previous.and_then(|value| value.get("max")), maximum_number as i64);
                (safe_int(previous.and_then(|value| value.get("current")), 0) as f64) + (maximum_number - max_before as f64).max(0.0)
            } else {
                safe_int(previous.and_then(|value| value.get("current")), maximum_number as i64) as f64
            };
            let current = wanted.min(maximum_number).max(0.0);
            next.insert(resource.clone(), json!({ "current": js::num(current), "max": maximum }));
        }
    }
    // Массив `resources` принимает поле молча, в JSON его не видно.
    if let Some(Value::Object(all)) = mechanics_mut(state).get_mut("resources") {
        all.insert(key, Value::Object(next));
    }
    Ok(())
}

/// Порог вех списывает только повышение, оплаченное вехами
/// (`progression.milestones_since_level - MILESTONES_PER_LEVEL`, не меньше
/// нуля). У `progression` не объекта JS бросает `TypeError`.
fn spend_milestones(state: &mut Value) -> Reduced {
    let progression = match mechanics_mut(state).get_mut("progression") {
        Some(progression @ Value::Object(_)) => progression,
        Some(Value::Null) | None => return Err(type_error("Cannot set properties of undefined (setting 'milestones_since_level')")),
        // У примитива присваивание в строгом режиме — тоже `TypeError`.
        Some(_) => return Err(type_error("Cannot create property 'milestones_since_level' on primitive")),
    };
    let left = js::number(progression.get("milestones_since_level")) - MILESTONES_PER_LEVEL as f64;
    // `Math.max(0, NaN)` — `NaN`.
    let since = if left.is_nan() { f64::NAN } else { left.max(0.0) };
    progression["milestones_since_level"] = js::num(since);
    progression["level_up_available"] = Value::Bool(since >= MILESTONES_PER_LEVEL as f64);
    Ok(())
}

/// `EncounterRewardsDistributed` (26939–26943).
pub(super) fn encounter_rewards_distributed(state: &mut Value, event: &Event) -> Reduced {
    let recipient_ids = sk_character::encounter_rewards::apply_encounter_rewards_distribution(state, &event_value(event)).map_err(|error| module_error(error.code, error.message))?;
    if !recipient_ids.is_empty() {
        refresh_player_derived_state(state, &recipient_ids)?;
    }
    Ok(())
}

/// `ExperienceAwarded` (26979–26993): опыт делится поровну, остаток — первым
/// в списке; поле `experience` получают все герои.
pub(super) fn experience_awarded(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    let recipient_ids = match payload.get("recipients") {
        Some(list @ Value::Array(_)) => unique_strings(Some(list)),
        _ => crate::core::unique_string_list(&event.target_ids),
    };
    let players = state.get("players").and_then(Value::as_array).cloned().unwrap_or_default();
    let player_ids: HashSet<String> = players.iter().map(actor_id).collect();
    let recipients: Vec<String> = recipient_ids.into_iter().filter(|id| player_ids.contains(id)).collect();
    let total = safe_int(payload.get("total_xp"), 0).max(0);
    if recipients.is_empty() || total <= 0 {
        return Ok(());
    }
    let count = recipients.len() as i64;
    let share = total.div_euclid(count);
    let remainder = total % count;
    let mut awards: HashMap<String, i64> = HashMap::new();
    for (index, id) in recipients.iter().enumerate() {
        awards.entry(id.clone()).or_insert(share + i64::from((index as i64) < remainder));
    }
    let next: Vec<Value> = players
        .into_iter()
        .map(|player| {
            let experience = (safe_int(player.get("experience"), 0) + awards.get(&actor_id(&player)).copied().unwrap_or(0)).max(0);
            js::spread(&player, json!({ "experience": experience }))
        })
        .collect();
    state["players"] = Value::Array(next);
    Ok(())
}

/// `MilestoneAwarded` (26994–27009): веха идемпотентна по `event_id`.
pub(super) fn milestone_awarded(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    let source = event.extra.get("event_id").filter(|value| !value.is_null()).or_else(|| payload.get("milestone").filter(|value| !value.is_null()));
    let id = head(&s(source), 160);
    let mechanics = mechanics_mut(state);
    let progression = mechanics.entry("progression").or_insert_with(js::obj);
    if !progression.is_object() {
        *progression = js::obj();
    }
    let milestones = progression.get("milestones").and_then(Value::as_array).cloned().unwrap_or_default();
    if id.is_empty() || milestones.iter().any(|entry| entry.get("id").and_then(Value::as_str) == Some(id.as_str())) {
        return Ok(());
    }
    let mut milestones = milestones;
    let mut entry = Map::new();
    entry.insert("id".into(), Value::String(id));
    entry.insert("milestone".into(), Value::String(head(&s(payload.get("milestone")), 160)));
    entry.insert("encounter_id".into(), Value::String(head(&s(payload.get("encounter_id")), 160)));
    milestones.push(Value::Object(entry));
    let keep = milestones.len().saturating_sub(200);
    let since = safe_int(progression.get("milestones_since_level"), 0) + 1;
    progression["milestones"] = Value::Array(milestones.into_iter().skip(keep).collect());
    progression["milestones_since_level"] = Value::from(since);
    progression["level_up_available"] = Value::Bool(since >= MILESTONES_PER_LEVEL);
    Ok(())
}

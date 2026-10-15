//! Ветки редьюсера `applyGameEventCurrent`: Герой: выбор заклинаний и умений, броски характеристик и богатства, уровень и импорт, награды, опыт и вехи. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 26809–26825, 26826–26868, 26869–26871, 26872–26874, 26876–26916, 26917–26921, 26957–26971, 26972–26987. Таблица меток — `reduce/table.rs`
//! (Р0). Перенося ветку, уберите её метки из [`UNPORTED`] этого файла.
//!
//! Не перенесены ветки, которым нужен `character-lifecycle` (крейт
//! `sk-character`: `deriveCharacterSheet`, `characterCreationChoicesComplete`,
//! `applyCharacterLifecycleEvent`, `classResourcePlan`) и
//! `encounter-rewards` (`applyEncounterRewardsDistribution`).

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};
use sk_core::game::{actor_id, mechanics_mut, replace_actor};
use sk_core::js::{self, s, safe_int};
use sk_core::text::head;
use sk_core::Event;

use super::{target_of, Reduced};
use crate::core::unique_strings;
use crate::pause::unported;

/// Метки событий этого файла, чьи ветки ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[
    "SpellSelectionsUpdated",
    "CharacterChoicesUpdated",
    "CharacterLeveledUp",
    "CharacterImported",
    "EncounterRewardsDistributed",
];

/// `MILESTONES_PER_LEVEL`.
pub const MILESTONES_PER_LEVEL: i64 = 3;

/// `SpellSelectionsUpdated` (26809–26825).
pub(super) fn spell_selections_updated(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:SpellSelectionsUpdated"))
}

/// `CharacterChoicesUpdated` (26826–26868).
pub(super) fn character_choices_updated(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:CharacterChoicesUpdated"))
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

/// `CharacterAbilitiesRolled` (26869–26871).
pub(super) fn character_abilities_rolled(state: &mut Value, event: &Event) -> Reduced {
    record_creation_roll(state, event, "abilities")
}

/// `CharacterWealthRolled` (26872–26874).
pub(super) fn character_wealth_rolled(state: &mut Value, event: &Event) -> Reduced {
    record_creation_roll(state, event, "wealth")
}

/// `CharacterLeveledUp`, `CharacterImported` (26876–26916).
pub(super) fn character_lifecycle_event(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:CharacterLeveledUp"))
}

/// `EncounterRewardsDistributed` (26917–26921).
pub(super) fn encounter_rewards_distributed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:EncounterRewardsDistributed"))
}

/// `ExperienceAwarded` (26957–26971): опыт делится поровну, остаток — первым
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

/// `MilestoneAwarded` (26972–26987): веха идемпотентна по `event_id`.
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

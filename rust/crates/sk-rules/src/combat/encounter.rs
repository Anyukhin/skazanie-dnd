//! Сборка встречи из состояния и нападение на NPC (`assembleEncounterFromState`, `validateAttackNpcCommand`). Задача Р3.
//!
//! JS: `server/rules-engine.mjs`, 5800–6024: участники должности, пустое место
//! героя, сборка встречи (авторский NPC со стражей и засадой сценария или
//! сборщик по теме), вход сборщика, отпечаток нападения на NPC и проверка
//! `AttackNpc`.
//!
//! Отказ сборки в JS — исключение с `code` (`EncounterAssemblyError`,
//! `AuthoredNpcValidationError`, отказ сборщика) или без него (`TypeError`);
//! блок 48 `validateCommand` превращает любое в `RulesValidationError`
//! (`code ?? 'ENCOUNTER_ASSEMBLY_REJECTED'`). Здесь отказ с кодом — `Halt::Rule`,
//! без кода — `Halt::Fault`; превращение блока 48 — [`assemble_encounter_for_command`].

use serde_json::{json, Map, Value};
use sk_core::{game, js, text, RuleError};
use sk_geometry::Point;

use crate::combat::weapons::array_of;
use crate::conditions::at;
use crate::core::{player_actor, string_of};
use crate::pause::{rule, Fault, Halt, Step};
use crate::tactical_geometry::{self as tg, KeySet};

const CREATURE_ENTITY_KINDS: [&str; 1] = ["enemy"];

/// `authoredOfficeParticipants(state, npcId)` (5800–5803): держатель
/// должности NPC и её защитники.
pub fn authored_office_participants(state: &Value, npc_id: &str) -> Vec<String> {
    let offices = array_of(at(state.get("world_offices"), "offices"));
    let office = offices.iter().find(|entry| {
        entry.get("holder_npc_id").and_then(Value::as_str) == Some(npc_id) || crate::conditions::includes_str(entry.get("defender_npc_ids"), npc_id)
    });
    let mut list: Vec<String> = vec![npc_id.to_string(), js::string(at(office, "holder_npc_id"))];
    match at(office, "defender_npc_ids") {
        Some(Value::Array(ids)) => list.extend(ids.iter().map(string_of)),
        Some(Value::String(text)) => list.extend(text.chars().map(|ch| ch.to_string())),
        _ => {}
    }
    crate::core::unique_string_list(&list)
}

/// `isEmptyHeroSeat(actor)` (5811): место героя без созданного героя.
pub fn is_empty_hero_seat(actor: Option<&Value>) -> bool {
    js::is_true(at(actor, "characterSetupRequired")) && at(actor, "characterSetupStage").and_then(Value::as_str) != Some("leveling")
}

fn assembly_error(message: &str, code: &str) -> Halt {
    rule(message, code)
}

/// `validateEncounterPlacements(proposal)` (5822–5850): площадь каждого
/// существа встречи не пересекает стен, реквизита и друг друга.
fn validate_encounter_placements(state: &Value, proposal: Value) -> Result<Value, Halt> {
    let map = tg::scene_tactical_map(state);
    let cells = tg::tactical_cell_map(state);
    let prop_occupied: KeySet = if map.is_some() { tg::prop_movement_positions(map.as_ref()) } else { KeySet::new() };
    let mut occupied = KeySet::new();
    for enemy in array_of(proposal.get("enemies")) {
        let anchor = Point::new(js::number(at(Some(enemy), "x")), js::number(at(Some(enemy), "y")));
        let footprint = tg::footprint_cells(Some(enemy), Some(anchor));
        if footprint.is_empty() || !tg::is_safe(anchor.x) || !tg::is_safe(anchor.y) {
            return Err(assembly_error("Встреча содержит недопустимую расстановку", "ENCOUNTER_INVALID_PLACEMENT"));
        }
        if !footprint.iter().all(|cell| cells.contains_key(&tg::key_of(*cell))) {
            continue;
        }
        if map.is_some() && tg::footprint_placement_edges_blocked(map.as_ref(), Some(enemy), Some(anchor)) {
            return Err(assembly_error("Площадь существа пересекает внутреннюю преграду", "ENCOUNTER_FOOTPRINT_BLOCKED"));
        }
        for cell in footprint {
            let key = tg::key_of(cell);
            if !tg::is_walkable_cell(cells.get(&key).copied()) || prop_occupied.contains(&key) || occupied.contains(&key) {
                return Err(assembly_error("Площадь существа заняла недоступную клетку", "ENCOUNTER_FOOTPRINT_BLOCKED"));
            }
            occupied.insert(key);
        }
    }
    Ok(proposal)
}

/// Отказ сборщика или каталога в остановку разбора: с кодом — отказ правила.
fn assemble_failure(error: sk_encounters::encounter_assembler::AssembleFailure) -> Halt {
    use sk_encounters::encounter_assembler::AssembleFailure;
    let message = error.to_string();
    match &error {
        AssembleFailure::Roster(_) => Halt::Fault(Fault::type_error(message)),
        AssembleFailure::Content(_) => Halt::Fault(Fault::new("Error", message)),
        _ => match error.code() {
            Some(code) => Halt::Rule(RuleError::new(code, message)),
            None => Halt::Fault(Fault::new("Error", message)),
        },
    }
}

fn assemble(input: &Value) -> Result<Value, Halt> {
    sk_encounters::encounter_assembler::assemble_encounter(Some(input)).map_err(assemble_failure)
}

fn ruleset_of(state: &Value) -> Value {
    state.get("ruleset_id").cloned().unwrap_or(Value::Null)
}

/// `assembleEncounterFromState(state, command)` (5815–5925).
pub fn assemble_encounter_from_state(state: &Value, command: &Value) -> Result<Value, Halt> {
    let authored_raw = crate::core::coalesce(&[command.get("npc_id"), command.get("authored_npc_id")]);
    let authored_npc_id = text::trim(&js::s(authored_raw)).to_string();
    if authored_npc_id.is_empty() {
        let input = encounter_assembly_input(state, &KeySet::new())?;
        let mut request = Map::new();
        request.insert("ruleset_id".into(), ruleset_of(state));
        request.insert("scene".into(), json!({ "cells": input.cells }));
        request.insert("party".into(), Value::Array(input.party));
        for field in ["difficulty", "theme", "seed"] {
            if let Some(value) = command.get(field) {
                request.insert(field.into(), value.clone());
            }
        }
        let proposal = assemble(&Value::Object(request))?;
        return validate_encounter_placements(state, proposal);
    }
    let id_value = Value::String(authored_npc_id.clone());
    let present = sk_npc_world::npc_positioning::present_scene_npcs(state);
    let Some(npc) = present.iter().find(|candidate| js::string(candidate.get("id")) == authored_npc_id).cloned() else {
        return Err(rule("Авторский NPC отсутствует в текущей сцене", "AUTHORED_NPC_NOT_PRESENT"));
    };
    let mechanics_of = |id: &str| sk_npc_world::npc_positioning::npc_mechanics_for(state, &Value::String(id.to_string()));
    let Some(mechanics) = mechanics_of(&authored_npc_id) else {
        return Err(rule("У NPC нет проверенного боевого листа", "AUTHORED_NPC_PROFILE_MISSING"));
    };
    let placement_of = |id: &str| sk_npc_world::npc_positioning::npc_placement_for(state, &Value::String(id.to_string()), None);
    let Some(placement) = placement_of(&authored_npc_id) else {
        return Err(rule("Авторский NPC ещё не размещён на карте сцены", "AUTHORED_NPC_PLACEMENT_MISSING"));
    };
    let seed_text = format!("{}\0{}\0{}\0{}", js::s(state.get("sessionCode")), authored_npc_id, js::s(command.get("command_id")), js::s(command.get("seed")));
    let fingerprint = sk_core::hash::sha256_hex(seed_text.as_bytes());
    let vital = sk_npc_world::npc_positioning::npc_vital_for(state, &id_value);
    let combatant = sk_heroes::authored_npc::authored_npc_combatant(Some(&npc), Some(&mechanics), Some(&placement)).map_err(|error| Halt::Rule(RuleError::new(error.code.clone(), error.message.clone())))?;
    let mut enemy = crate::core::spread_value(Some(&combatant));
    enemy.insert("footprint".into(), sk_geometry::actor_footprint::footprint_metadata_for_size(mechanics.get("size")).to_value());
    enemy.insert("hp".into(), vital.get("hp").cloned().unwrap_or(Value::Null));
    enemy.insert("maxHp".into(), vital.get("max_hp").cloned().unwrap_or(Value::Null));
    enemy.insert("alive".into(), vital.get("alive").cloned().unwrap_or(Value::Null));
    strip_missing(&mut enemy, &vital);
    let enemy = Value::Object(enemy);
    let difficulty = mechanics.get("encounter_difficulty").cloned();
    let defenders: Vec<Value> = authored_office_participants(state, &authored_npc_id)
        .into_iter()
        .filter(|id| {
            *id != authored_npc_id
                && present.iter().any(|candidate| candidate.get("id").and_then(Value::as_str) == Some(id.as_str()))
                && mechanics_of(id).is_none_or(|mechanics| mechanics.get("status").and_then(Value::as_str) != Some("ruling-only"))
                && mechanics_of(id).is_some()
                && placement_of(id).is_some()
        })
        .map(|id| crate::tactical_geometry::npc_positioning::npc_combat_actor_for(state, &id).unwrap_or(Value::Null))
        .collect();
    let tactics = sk_attention::scenario_attention::scenario_finale_tactics(state, std::slice::from_ref(&authored_npc_id));
    let ambush_spec = tactics.as_ref().and_then(|tactics| tactics.ambush.clone()).filter(|ambush| js::truthy(Some(ambush)));
    let ambush = match &ambush_spec {
        Some(spec) => {
            let mut taken = KeySet::new();
            for entry in std::iter::once(&enemy).chain(defenders.iter()) {
                let anchor = Point::new(js::number(at(Some(entry), "x")), js::number(at(Some(entry), "y")));
                for cell in tg::footprint_cells(Some(entry), Some(anchor)) {
                    taken.insert(tg::key_of(cell));
                }
            }
            let input = encounter_assembly_input(state, &taken)?;
            let mut request = Map::new();
            request.insert("ruleset_id".into(), ruleset_of(state));
            request.insert("scene".into(), json!({ "cells": input.cells }));
            request.insert("party".into(), Value::Array(input.party));
            if let Some(value) = spec.get("difficulty") {
                request.insert("difficulty".into(), value.clone());
            }
            if let Some(value) = spec.get("theme") {
                request.insert("theme".into(), value.clone());
            }
            request.insert("seed".into(), Value::String(format!("{fingerprint}:ambush")));
            Some(assemble(&Value::Object(request))?)
        }
        None => None,
    };
    let mut enemies = vec![enemy.clone()];
    enemies.extend(defenders.iter().cloned());
    if let Some(ambush) = &ambush {
        enemies.extend(array_of(ambush.get("enemies")).iter().cloned());
    }
    let positive = |value: f64| if value.is_nan() || value == 0.0 { 0.0 } else { value.max(0.0) };
    let mut xp = 0.0;
    for entry in std::iter::once(&enemy).chain(defenders.iter()) {
        xp += positive(js::number(mechanics_of(&js::s(at(Some(entry), "id"))).as_ref().and_then(|mechanics| mechanics.get("xp"))));
    }
    xp += positive(js::number(ambush.as_ref().and_then(|ambush| ambush.get("xp_spent"))));
    let xp = js::num(xp);
    let mut proposal = Map::new();
    proposal.insert("proposal_id".into(), Value::String(format!("encounter-proposal-{}", &fingerprint[..24])));
    proposal.insert("version".into(), Value::String(sk_encounters::encounter_assembler::ENCOUNTER_PROPOSAL_VERSION.into()));
    if let Some(difficulty) = &difficulty {
        proposal.insert("difficulty".into(), difficulty.clone());
    }
    proposal.insert("difficulty_label".into(), sk_encounters::encounter_assembler::encounter_difficulty_label(difficulty.as_ref()).unwrap_or(Value::Null));
    proposal.insert("theme".into(), Value::String("generic".into()));
    proposal.insert("xp_budget".into(), xp.clone());
    proposal.insert("xp_spent".into(), xp.clone());
    proposal.insert(
        "threat".into(),
        json!({ "budget_xp": xp, "spent_xp": xp, "unspent_xp": 0, "utilization_bps": 10_000, "quantity": enemies.len(), "quantity_cap": enemies.len() }),
    );
    let ambush_ids: Vec<String> = ambush.as_ref().map(|ambush| array_of(ambush.get("enemies")).iter().map(|entry| js::string(entry.get("id"))).collect()).unwrap_or_default();
    proposal.insert("enemies".into(), Value::Array(enemies));
    let mut source = Map::new();
    source.insert("kind".into(), Value::String("server-owned-authored-npc-profile".into()));
    if let Some(profile_id) = mechanics.get("profile_id") {
        source.insert("profile_id".into(), profile_id.clone());
    }
    proposal.insert("source".into(), Value::Object(source));
    if let (Some(_), Some(spec)) = (&ambush, &ambush_spec) {
        let mut entry = Map::new();
        if let Some(theme) = spec.get("theme") {
            entry.insert("theme".into(), theme.clone());
        }
        if let Some(value) = spec.get("difficulty") {
            entry.insert("difficulty".into(), value.clone());
        }
        entry.insert("reason".into(), Value::String(tactics.as_ref().map(|tactics| tactics.reason).unwrap_or_default().into()));
        entry.insert("enemy_ids".into(), js::strings_value(ambush_ids));
        proposal.insert("scenario_ambush".into(), Value::Object(entry));
    }
    validate_encounter_placements(state, Value::Object(proposal))
}

/// Поля живучести, которых нет в записи (`vital.hp` — `undefined`), JSON не несёт.
fn strip_missing(enemy: &mut Map<String, Value>, vital: &Value) {
    for (field, source) in [("hp", "hp"), ("maxHp", "max_hp"), ("alive", "alive")] {
        if vital.get(source).is_none() {
            enemy.shift_remove(field);
        }
    }
}

/// Блок 48 `validateCommand` (6916–6920): `command.encounter`; любой отказ
/// сборки — `RulesValidationError` с кодом ошибки или `ENCOUNTER_ASSEMBLY_REJECTED`.
pub fn assemble_encounter_for_command(state: &Value, command: &Value) -> Result<Value, RuleError> {
    assemble_encounter_from_state(state, command).map_err(|halt| match halt {
        Halt::Rule(error) => error,
        Halt::Fault(fault) => RuleError::new(fault.code.unwrap_or_else(|| "ENCOUNTER_ASSEMBLY_REJECTED".into()), fault.message),
        Halt::Pause(pause) => RuleError::new("ENCOUNTER_ASSEMBLY_REJECTED", pause.message()),
    })
}

/// Вход сборщика встречи (`encounterAssemblyInput`).
#[derive(Debug, Clone, Default)]
pub struct AssemblyInput {
    pub party: Vec<Value>,
    pub cells: Vec<Value>,
}

/// `encounterAssemblyInput(state, occupiedKeys)` (5935–5990): живые герои с
/// позициями и клетки сцены с отметкой занятости и стенами.
pub fn encounter_assembly_input(state: &Value, occupied_keys: &KeySet) -> Result<AssemblyInput, Halt> {
    let players = array_of(state.get("players"));
    let member_ids: Vec<String> = match state.get("partyMemberIds").and_then(Value::as_array).filter(|ids| !ids.is_empty()) {
        Some(ids) => ids.iter().map(string_of).collect(),
        None => players.iter().map(game::actor_id).collect(),
    };
    let party: Vec<Value> = players
        .iter()
        .filter(|actor| member_ids.contains(&game::actor_id(actor)) && game::is_living_actor(actor) && !is_empty_hero_seat(Some(actor)))
        .map(|actor| {
            let id = game::actor_id(actor);
            let position = game::actor_position(state, &id);
            let mut member = Map::new();
            member.insert("id".into(), Value::String(id));
            member.insert("level".into(), Value::from(js::safe_int(actor.get("level"), 1).clamp(1, 20)));
            if let Some(position) = position {
                member.insert("x".into(), Value::from(position.x));
                member.insert("y".into(), Value::from(position.y));
            }
            Value::Object(member)
        })
        .collect();
    if party.is_empty() {
        return Err(rule("Некому вступить в бой: все герои отряда без сознания или погибли. Сначала отряду нужно прийти в себя", "PARTY_UNAVAILABLE"));
    }
    let party_ids: Vec<String> = party.iter().map(|member| js::s(member.get("id"))).collect();
    let mut creature_cells = occupied_keys.clone();
    for actor in game::list_actors(state) {
        let id = game::actor_id(actor);
        if !game::is_living_actor(actor) || party_ids.contains(&id) {
            continue;
        }
        for cell in tg::actor_footprint_cells_at(state, &id, None) {
            creature_cells.insert(tg::key_of(cell));
        }
    }
    for entity in array_of(state.get("entities")) {
        if !CREATURE_ENTITY_KINDS.contains(&js::string(at(Some(entity), "kind")).as_str()) {
            continue;
        }
        let x = js::number(at(Some(entity), "x"));
        let y = js::number(at(Some(entity), "y"));
        if tg::is_safe(x) && tg::is_safe(y) {
            for cell in tg::footprint_cells(Some(entity), Some(Point::new(x, y))) {
                creature_cells.insert(tg::key_of(cell));
            }
        }
    }
    let map = tg::scene_tactical_map(state);
    let blocked_props = tg::prop_movement_positions(map.as_ref());
    let cells: Vec<Value> = array_of(at(state.get("scene"), "cells"))
        .iter()
        .map(|cell| {
            let x = js::number(at(Some(cell), "x"));
            let y = js::number(at(Some(cell), "y"));
            let mut entry = Map::new();
            entry.insert("x".into(), js::num(x));
            entry.insert("y".into(), js::num(y));
            let kind = at(Some(cell), "type").filter(|value| !value.is_null()).map(string_of).unwrap_or_else(|| "floor".into());
            entry.insert("type".into(), Value::String(kind));
            entry.insert("revealed".into(), Value::Bool(js::is_true(at(Some(cell), "revealed"))));
            if let Some(feature) = at(Some(cell), "feature").filter(|value| !value.is_null()) {
                entry.insert("feature".into(), Value::String(string_of(feature)));
            }
            let key = tg::key(x, y);
            if creature_cells.contains(&key) || blocked_props.contains(&key) {
                entry.insert("occupied".into(), Value::Bool(true));
            }
            let walls = sk_encounters::encounter_assembler::encounter_barrier_sides(Some(cell));
            if !walls.is_empty() {
                entry.insert("walls".into(), Value::String(walls.into()));
            }
            Value::Object(entry)
        })
        .collect();
    Ok(AssemblyInput { party, cells })
}

/// `npcCombatRequestFingerprint(command)` (5983, экспорт): отпечаток
/// нападения на NPC — герой и NPC, больше ничего.
pub fn npc_combat_request_fingerprint(command: &Value) -> String {
    let semantic = json!({
        "type": "AttackNpc",
        "actor_id": js::s(command.get("actor_id")),
        "npc_id": js::s(crate::core::coalesce(&[command.get("npc_id"), command.get("npcId")])),
    });
    sk_core::hash::sha256_hex(js::stringify(&semantic).as_bytes())
}

/// `validateAttackNpcCommand(command, state)` (5992–6024): нападение героя на
/// видимого NPC; дописывает `npc_id` и `request_fingerprint`.
pub fn validate_attack_npc_command(command: &mut Value, state: &Value) -> Step {
    if game::combat_active(state) {
        return Err(rule("Нельзя начать новый бой во время активного боя", "ENCOUNTER_DURING_COMBAT"));
    }
    let encounter_status = js::s(at(game::mechanics(state).get("encounter"), "status"));
    if array_of(state.get("enemies")).iter().any(game::is_living_actor) || matches!(encounter_status.as_str(), "staged" | "active") {
        return Err(rule("В текущей сцене уже есть незавершённое столкновение", "ENCOUNTER_ALREADY_PRESENT"));
    }
    let Some(hero) = player_actor(state, command.get("actor_id")) else {
        return Err(rule("Напасть может только герой отряда", "ACTOR_FORBIDDEN"));
    };
    if !game::is_living_actor(hero) {
        return Err(rule("Герой без сознания не может начать бой", "ACTOR_DEFEATED"));
    }
    let npc_id = text::trim(&js::s(command.get("npc_id"))).to_string();
    let npc_value = Value::String(npc_id.clone());
    let npc = array_of(at(state.get("social"), "npcs")).iter().find(|candidate| js::s(at(Some(candidate), "id")) == npc_id);
    if npc.is_none() {
        return Err(rule("Выбранный NPC отсутствует в текущей сцене", "AUTHORED_NPC_NOT_PRESENT"));
    }
    if sk_npc_world::npc_positioning::npc_interaction_target_for_viewer(state, &npc_value).is_none() {
        return Err(rule("Выбранный NPC не виден этому игроку", "AUTHORED_NPC_NOT_VISIBLE"));
    }
    let Some(mechanics) = sk_npc_world::npc_positioning::npc_mechanics_for(state, &npc_value) else {
        return Err(rule("У NPC нет проверенного боевого листа", "AUTHORED_NPC_PROFILE_MISSING"));
    };
    if mechanics.get("status").and_then(Value::as_str) == Some("ruling-only") {
        return Err(rule("Боевой профиль NPC требует решения ведущего", "AUTHORED_NPC_PROFILE_UNVERIFIED"));
    }
    let vital = sk_npc_world::npc_positioning::npc_vital_for(state, &npc_value);
    if !js::truthy(vital.get("alive")) {
        return Err(rule("NPC уже выбыл из истории", "AUTHORED_NPC_NOT_ALIVE"));
    }
    let present = sk_npc_world::npc_positioning::present_scene_npcs(state).iter().any(|candidate| js::string(candidate.get("id")) == npc_id);
    if !present {
        return Err(rule("Выбранный NPC сейчас недоступен", "AUTHORED_NPC_NOT_PRESENT"));
    }
    if sk_npc_world::npc_positioning::npc_placement_for(state, &npc_value, None).is_none() {
        return Err(rule("Авторский NPC ещё не размещён на карте сцены", "AUTHORED_NPC_PLACEMENT_MISSING"));
    }
    if let Some(map) = command.as_object_mut() {
        map.insert("npc_id".into(), npc_value);
    }
    let fingerprint = npc_combat_request_fingerprint(command);
    if let Some(map) = command.as_object_mut() {
        map.insert("request_fingerprint".into(), Value::String(fingerprint));
    }
    Ok(())
}

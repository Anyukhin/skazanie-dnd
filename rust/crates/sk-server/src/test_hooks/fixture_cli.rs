//! Подкоманда `skazanie-server fixture` — входные данные контрактных тестов
//! тем же кодом, что работает в игре. Контракт — `test/kit/fixtures.mjs`.
//!
//! ```text
//! skazanie-server fixture   (JSON [имя, ...аргументы] или { "batch": [[имя, ...], ...] } на stdin)
//! ```
//!
//! Контрактный HTTP-тест готовит кампанию сам: карту с дверью и сундуком,
//! предмет из каталога, бой стенда, сцену Асстохана после перехода. Раньше он
//! строил это JS-библиотекой (`server/tactical-map.mjs`, `rules-engine.mjs`,
//! `campaign-bootstrap.mjs`), то есть входы готовил не тот код, что их потом
//! исполнял. Здесь те же функции из крейтов Rust под именами JS — тест
//! получает ровно ту форму, которую сервер сам построил бы и принял.
//!
//! Функции чистые: хранилища, сети и модели нет (агенты — без клиента
//! модели, как в офлайн-игре). В stdout — JSON-результат (у пакета —
//! `{ "results": [...] }`); отказ — код 1 и `{ "error": { "code", "message" } }`
//! в stderr; неверный вход — код 2. Без фичи `test-hooks` подкоманды нет.

use std::io::Read;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_dice::{DiceService, FixedRng, Rng, SequenceRng};
use sk_geometry::Point;
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::outcome::Outcome;
use sk_rules::resolve::api;
use sk_tactical::tactical_map::{self as tm, CatalogRevision, CellPatchJson, LegacyMapOptions, TacticalMap, TacticalMapOptions};

/// Отказ функции: код (если есть) и текст.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: String,
    pub message: String,
}

impl Failure {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }

    fn to_json(&self) -> Value {
        json!({ "error": { "code": self.code, "message": self.message } })
    }
}

fn fault(error: impl std::fmt::Display) -> Failure {
    Failure::new("FIXTURE_FAILED", error.to_string())
}

/// Отказ правила — код и текст `RulesValidationError`; прочая ошибка — её имя и текст.
fn halt(error: sk_rules::pause::Halt) -> Failure {
    match error {
        sk_rules::pause::Halt::Rule(rule) => Failure::new(&rule.code, rule.message),
        sk_rules::pause::Halt::Fault(fault) => Failure::new(fault.code.as_deref().unwrap_or(&fault.name), fault.message),
    }
}

fn arg(args: &[Value], index: usize) -> &Value {
    args.get(index).unwrap_or(&Value::Null)
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Параметры `createTacticalMap({ width, height, locationId, seed, fill, … })`.
fn map_options(options: &Value) -> Result<TacticalMap, Failure> {
    let generator = options.get("generator").filter(|value| value.is_object()).map(|value| (text(value, "id"), text(value, "version")));
    let fill = options.get("fill").filter(|value| value.is_object()).map(CellPatchJson::from_json);
    let catalog_revision = match options.get("catalogRevision") {
        None => CatalogRevision::Current,
        Some(Value::Null) => CatalogRevision::Omit,
        Some(Value::String(value)) => CatalogRevision::Value(value),
        Some(other) => return Err(Failure::new("FIXTURE_INPUT", format!("catalogRevision: строка или null, получено {other}"))),
    };
    let built = TacticalMapOptions {
        width: options.get("width").and_then(Value::as_i64).unwrap_or(1),
        height: options.get("height").and_then(Value::as_i64).unwrap_or(1),
        location_id: text(options, "locationId"),
        level_index: options.get("levelIndex").and_then(Value::as_i64).unwrap_or(0),
        level_label: text(options, "levelLabel"),
        seed: text(options, "seed"),
        generator,
        theme: text(options, "theme"),
        tileset_id: text(options, "tilesetId"),
        size_class: text(options, "sizeClass"),
        catalog_revision,
        fill: fill.as_ref().map(CellPatchJson::patch),
    };
    tm::create_tactical_map(&built).map_err(fault)
}

fn number(value: &Value, index: usize) -> i64 {
    value.get(index).and_then(Value::as_f64).map(|number| number as i64).unwrap_or(0)
}

/// `buildMap({ options, steps })`: карта по шагам, как тест строил её
/// `createTacticalMap` + `setDoor`/`addProp`/`setCell`/`setEdge`. Шаг —
/// `{ "door": {…} }`, `{ "prop": {…} }`, `{ "cell": [x, y, заплатка] }` или
/// `{ "edge": [ax, ay, bx, by, ребро] }`. Ответ — `{ map, cells }`: карта в
/// форме `serializeTacticalMap` и клетки `legacyCellsFromTacticalMap`.
fn build_map(spec: &Value) -> Result<Value, Failure> {
    let mut map = map_options(spec.get("options").unwrap_or(&Value::Null))?;
    apply_steps(&mut map, spec.get("steps"))?;
    map_output(&map)
}

/// Шаги построителя по порядку: `{door}`, `{prop}`, `{cell: [x, y, patch]}`,
/// `{edge: [ax, ay, bx, by, edge]}` — `setDoor`, `addProp`, `setCell`, `setEdge`.
fn apply_steps(map: &mut TacticalMap, steps: Option<&Value>) -> Result<(), Failure> {
    for step in steps.and_then(Value::as_array).into_iter().flatten() {
        if let Some(door) = step.get("door") {
            tm::set_door(map, door).map_err(fault)?;
        } else if let Some(prop) = step.get("prop") {
            tm::add_prop(map, prop).map_err(fault)?;
        } else if let Some(cell) = step.get("cell") {
            tm::set_cell_json(map, number(cell, 0), number(cell, 1), cell.get(2).unwrap_or(&Value::Null)).map_err(fault)?;
        } else if let Some(edge) = step.get("edge") {
            tm::set_edge_json(map, number(edge, 0), number(edge, 1), number(edge, 2), number(edge, 3), edge.get(4).unwrap_or(&Value::Null)).map_err(fault)?;
        } else {
            return Err(Failure::new("FIXTURE_INPUT", format!("шаг карты: неизвестный шаг {step}")));
        }
    }
    Ok(())
}

fn map_output(map: &TacticalMap) -> Result<Value, Failure> {
    Ok(json!({ "map": tm::serialize_tactical_map(map).map_err(fault)?, "cells": tm::legacy_cells_from_tactical_map(map) }))
}

/// `readMap(map)`: карта в форме `serializeTacticalMap`, все её существующие
/// клетки, как их отдаёт `cellAt`, и предметы целиком, как в
/// `deserializeTacticalMap(map).props` (с `blocksMove` и прочим из каталога).
fn read_map(serialized: &Value) -> Result<Value, Failure> {
    let map = tm::deserialize_tactical_map(serialized).map_err(fault)?;
    let mut cells = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            if let Some(cell) = tm::cell_at(&map, x, y) {
                cells.push(json!({
                    "x": cell.x, "y": cell.y, "passable": cell.passable, "moveCost": cell.move_cost, "surface": cell.surface,
                    "hazardId": cell.hazard_id, "material": cell.material, "elevation": cell.elevation, "zone": cell.zone,
                    "variant": cell.variant, "revealed": cell.revealed,
                }));
            }
        }
    }
    let props: Vec<Value> = map.props.iter().map(tm::TacticalProp::to_json).collect();
    Ok(json!({ "map": tm::serialize_tactical_map(&map).map_err(fault)?, "cells": cells, "props": props }))
}

fn points(value: &Value) -> Vec<Point> {
    value.as_array().into_iter().flatten().map(|point| Point { x: point.get("x").and_then(Value::as_f64).unwrap_or(0.0), y: point.get("y").and_then(Value::as_f64).unwrap_or(0.0) }).collect()
}

fn point_json(point: &Point) -> Value {
    json!({ "x": js::num(point.x), "y": js::num(point.y) })
}

/// Кости разбора: `{ dice: [значения] }` — по очереди, `{ fixed: n }` — одно
/// значение на каждой кости, иначе — костей нет (лишний бросок — отказ).
fn with_dice<T>(options: &Value, run: impl FnOnce(&mut dyn sk_rules::dice_record::RulesDice) -> T) -> T {
    fn go<R: Rng + 'static, T>(rng: R, run: impl FnOnce(&mut dyn sk_rules::dice_record::RulesDice) -> T) -> T {
        let mut dice = ServiceDice::new(DiceService::deterministic(rng, "fixture"));
        run(&mut dice)
    }
    if let Some(fixed) = options.get("fixed").and_then(Value::as_i64) {
        return go(FixedRng(fixed), run);
    }
    let values: Vec<i64> = options.get("dice").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_i64).collect();
    go(SequenceRng::new(values), run)
}

fn context(options: &Value) -> Context {
    Context::from_json(options.get("context").unwrap_or(&Value::Null))
}

/// `resolveCommands(commands, state, { context, dice | fixed })`: план целиком.
fn resolve_commands(commands: &Value, state: &Value, options: &Value) -> Result<Value, Failure> {
    let commands = commands.as_array().cloned().unwrap_or_default();
    let stop = options.get("stopAttackAfterMovement").and_then(Value::as_bool).unwrap_or(false);
    let mut uuid = sequence_uuids("fixture");
    let plan = with_dice(options, |dice| api::resolve_commands(&commands, state, dice, &context(options), stop, &mut uuid)).map_err(halt)?;
    Ok(json!({ "commands": plan.commands, "events": plan.events, "rolls": plan.rolls, "state": plan.state, "pending": plan.pending.is_some() }))
}

/// `resolveCommand(command, state, { context, dice | fixed })`: события одной
/// команды и состояние после них (`replayEvents`).
fn resolve_command(command: &Value, state: &Value, options: &Value) -> Result<Value, Failure> {
    let mut uuid = sequence_uuids("fixture");
    let outcome = with_dice(options, |dice| api::resolve_command(command, state, dice, &context(options), &mut uuid)).map_err(halt)?;
    let (resolved, pending) = match outcome {
        Outcome::Committed(resolved) => (resolved, false),
        Outcome::Pending { resolved, .. } => (resolved, true),
    };
    let after = sk_rules::replay::replay_events(state, &resolved.events).map_err(halt)?;
    Ok(json!({ "command": resolved.command, "events": resolved.events, "rolls": resolved.rolls, "state": after, "pending": pending }))
}

fn block_on<F: std::future::Future>(future: F) -> Result<F::Output, Failure> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(fault)?;
    Ok(runtime.block_on(future))
}

fn optional(value: Option<Value>) -> Value {
    value.unwrap_or(Value::Null)
}

/// Карта из комнаты и факты для сверки авторского текста в стенде.
fn inspect_scene_map(raw: &Value, text: &Value, program: &Value, audit: bool) -> Value {
    use sk_map_core::map_quality::{audit_tactical_map, count_platforms, program_report};
    use sk_scene_base::scene_requirements::{requirement_label, requirements_coverage, scene_requirements_from_text};

    let Ok(map) = tm::deserialize_tactical_map(raw) else { return Value::Null };
    let mut props = Map::new();
    for prop in &map.props {
        let count = props.entry(prop.asset_id.clone()).or_insert(Value::from(0));
        *count = Value::from(count.as_u64().unwrap_or(0) + 1);
    }
    let mut mentioned = scene_requirements_from_text(text);
    for requirement in &mut mentioned {
        requirement.count = 1.0;
    }
    let terrain = json!({ "platform": count_platforms(&map) });
    let missing = requirements_coverage(&mentioned, Some(&Value::Object(props)), Some(&terrain)).missing;
    let objects = missing.iter().map(|id| json!({ "id": id, "label": requirement_label(id) })).collect::<Vec<_>>();
    if !audit {
        return json!({ "missingObjects": objects });
    }
    let problems = audit_tactical_map(&map).problems.iter().map(|problem| problem.to_json()).collect::<Vec<_>>();
    let program_problems = if program.is_object() {
        program_report(&map, program, &Default::default()).problems.iter().map(|problem| {
            let label = requirement_label(problem.detail.as_deref().unwrap_or_default());
            json!({ "code": problem.code, "detail": problem.detail, "label": label })
        }).collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    json!({
        "missingObjects": objects, "problems": problems, "programProblems": program_problems,
        "propCount": map.props.len(), "passableCells": tm::cells(&map).filter(|cell| cell.passable).count(),
    })
}

/// Сверить ответ, собранный из материала Хранителя, его же рендером.
fn matches_rendered_lore_plan(answer: &str, material: &Value) -> bool {
    use sk_agents::lore_voice::{render_lore_plan, validate_lore_plan};
    fn visit(answer: &str, material: &Value, without_closing: &Value, plan: &mut Vec<Value>, remaining: &[Value]) -> bool {
        if render_lore_plan(plan, material) == answer && validate_lore_plan(Some(&json!({ "plan": plan })), Some(material)).valid {
            return true;
        }
        for (index, reference) in remaining.iter().enumerate() {
            plan.push(reference.clone());
            let prefix = render_lore_plan(plan, without_closing);
            let matched = if !prefix.is_empty() && answer.contains(&prefix) {
                let next = remaining.iter().enumerate().filter(|(other, _)| *other != index).map(|(_, value)| value.clone()).collect::<Vec<_>>();
                visit(answer, material, without_closing, plan, &next)
            } else {
                false
            };
            plan.pop();
            if matched {
                return true;
            }
        }
        false
    }

    let Some(fields) = material.as_object() else { return false };
    let references = ["found", "heard", "known", "lead"].into_iter().flat_map(|kind| {
        fields.get(kind).and_then(Value::as_array).into_iter().flatten().enumerate().map(move |(index, _)| json!({ "kind": kind, "index": index }))
    }).collect::<Vec<_>>();
    let mut without_closing = material.clone();
    without_closing["unknown"] = Value::Bool(false);
    without_closing["hook"] = Value::String(String::new());
    visit(answer, material, &without_closing, &mut Vec::new(), &references)
}

/// Одна функция по имени JS.
pub fn call(name: &str, args: &[Value]) -> Result<Value, Failure> {
    let a = |index: usize| arg(args, index);
    match name {
        "createCharacterSlot" => sk_character::character_lifecycle::create_character_slot(a(0).get("id"), a(0).get("index")).map_err(fault),
        "characterProgression" => {
            use sk_character::character_lifecycle::character_creation_choices_complete;
            use sk_combat_content::combat_actions::{combat_class_catalog_info, combat_subclass_options_for, normalized_combat_subclass_for};
            use sk_ruleset::character_progression::{ability_score_choice_levels_for, class_skill_rule_for, normalized_class_skill_proficiencies};

            let actor = args.first();
            if character_creation_choices_complete(actor, Some(&json!({ "rulesetId": a(1) }))).map_err(fault)? {
                return Ok(json!({ "complete": true }));
            }
            let catalog = combat_class_catalog_info();
            let subclass_level = catalog["classes"].as_array().into_iter().flatten()
                .find(|entry| entry.get("classKey") == a(0).get("characterClass"))
                .and_then(|entry| entry.get("subclassLevel"));
            Ok(json!({
                "complete": false, "skillRule": class_skill_rule_for(actor), "skills": normalized_class_skill_proficiencies(actor),
                "subclassOptions": combat_subclass_options_for(actor), "normalizedSubclass": normalized_combat_subclass_for(actor),
                "subclassLevel": subclass_level, "asiLevels": ability_score_choice_levels_for(actor),
            }))
        }
        "characterChoiceOptions" => {
            use sk_combat_content::combat_spells::{combat_spells_for, spell_selection_rules_for};
            use sk_ruleset::character_progression::feature_choice_groups_for;

            let actor = args.first();
            let mut unselected = a(0).as_object().cloned().unwrap_or_default();
            unselected.shift_remove("knownSpellIds");
            unselected.shift_remove("preparedSpellIds");
            let rules = spell_selection_rules_for(actor).map(|rules| rules.to_value());
            let spells = rules.as_ref().map(|_| combat_spells_for(Some(&Value::Object(unselected)), Some(&json!({ "rulesetId": a(1) }))));
            Ok(json!({ "featureGroups": feature_choice_groups_for(actor), "spellRules": rules, "spells": spells }))
        }
        "planHeroCombatCommand" => sk_tactics::party_tactics::plan_hero_combat_command(a(0), a(1).as_str().unwrap_or("")).map(|step| step.to_json()).map_err(halt),
        "worldClockForAgents" => Ok(sk_world_time::weather::world_clock_for_agents(a(0), None)),
        "inspectSceneMap" => Ok(inspect_scene_map(a(0), a(1), a(2), a(3).as_bool().unwrap_or(false))),
        "answerKnownLore" => {
            let options = sk_agents::player_request_router::KnownLoreOptions {
                viewer: a(2).get("viewer").cloned(), actor_id: a(2).get("actorId").cloned(),
            };
            Ok(optional(sk_agents::player_request_router::answer_known_lore(a(0).as_str().unwrap_or(""), a(1), &options)))
        }
        "matchesRenderedLorePlan" => Ok(Value::Bool(matches_rendered_lore_plan(a(0).as_str().unwrap_or(""), a(1)))),
        "narratorClicheCatalog" => serde_json::to_value(sk_narration_base::narrator_craft_quality::NARRATOR_CLICHE_CATALOG).map_err(fault),
        "findNarratorCliches" => {
            let matches = a(0).as_array().into_iter().flatten().flat_map(|text| sk_narration_base::narrator_craft_quality::find_narrator_cliches(Some(text)));
            serde_json::to_value(matches.collect::<Vec<_>>()).map_err(fault)
        }
        "buildMap" => build_map(a(0)),
        "readMap" => read_map(a(0)),
        "editMap" => {
            let mut map = tm::deserialize_tactical_map(a(0)).map_err(fault)?;
            apply_steps(&mut map, args.get(1))?;
            map_output(&map)
        }
        "tacticalMapFromLegacyCells" => {
            let cells = a(0).as_array().cloned().unwrap_or_default();
            let options = a(1);
            let generator = options.get("generator").filter(|value| value.is_object()).map(|value| (text(value, "id"), text(value, "version")));
            let legacy = LegacyMapOptions { location_id: text(options, "locationId"), seed: text(options, "seed"), generator, tileset_id: text(options, "tilesetId") };
            let mut map = tm::tactical_map_from_legacy_cells(&cells, &legacy).map_err(fault)?;
            apply_steps(&mut map, args.get(2))?;
            map_output(&map)
        }
        "authoredLocationMapFor" => match sk_map_core::authored_location_maps::authored_location_map_for(Some(a(0))) {
            Some(map) => map_output(&map),
            None => Ok(Value::Null),
        },
        "materializeCatalogItem" => Ok(sk_items::item_catalog::materialize_catalog_item(a(0).as_str().unwrap_or(""), args.get(1).filter(|value| !value.is_null()))),
        "buildCombatLabState" => sk_tactics::combat_lab_setup::build_combat_lab_state(args.first(), &sk_tactics::combat_lab_setup::Sources::default()).map_err(fault),
        "normalizeCampaignState" => sk_rules::normalize::normalize_campaign_state(a(0)).map_err(halt),
        "replayEvents" => sk_rules::replay::replay_events(a(0), a(1).as_array().map(Vec::as_slice).unwrap_or_default()).map_err(halt),
        "resolveCommands" => resolve_commands(a(0), a(1), a(2)),
        "resolveCommand" => resolve_command(a(0), a(1), a(2)),
        "shortestTacticalPath" => {
            let target = a(2);
            let destination = Point { x: target.get("x").and_then(Value::as_f64).unwrap_or(0.0), y: target.get("y").and_then(Value::as_f64).unwrap_or(0.0) };
            let path = sk_rules::tactical_geometry::shortest_tactical_path(a(0), a(1).as_str().unwrap_or(""), destination, Default::default());
            Ok(path.map(|path| Value::Array(path.iter().map(point_json).collect())).unwrap_or(Value::Null))
        }
        // Пути и их цена до многих клеток при одном состоянии: пакет из
        // `shortestTacticalPath` повторял бы состояние комнаты на каждую клетку.
        "tacticalRoutes" => {
            let (state, actor_id) = (a(0), a(1).as_str().unwrap_or(""));
            let routes = a(2).as_array().map(Vec::as_slice).unwrap_or_default().iter().map(|target| {
                let destination = Point { x: target.get("x").and_then(Value::as_f64).unwrap_or(0.0), y: target.get("y").and_then(Value::as_f64).unwrap_or(0.0) };
                match sk_rules::tactical_geometry::shortest_tactical_path(state, actor_id, destination, Default::default()) {
                    Some(path) => {
                        let cost = sk_rules::geometry::terrain::movement_cost_of_path(state, actor_id, &path, None);
                        json!({ "path": path.iter().map(point_json).collect::<Vec<_>>(), "cost": js::num(cost) })
                    }
                    None => json!({ "path": null, "cost": null }),
                }
            });
            Ok(Value::Array(routes.collect()))
        }
        "movementCostOfPath" =>Ok(js::num(sk_rules::geometry::terrain::movement_cost_of_path(a(0), a(1).as_str().unwrap_or(""), &points(a(2)), None))),
        "createCampaign" => block_on(sk_agents::campaign_bootstrap::CampaignBootstrapper::default().create(a(0)))?.map_err(fault),
        "planScene" => {
            let input = a(0);
            let request = sk_agents::scene_architect::PlanRequest {
                action: text(input, "action").to_string(),
                decision: text(input, "decision").to_string(),
                destination_hint: text(input, "destinationHint").to_string(),
                destination_location_id: text(input, "destinationLocationId").to_string(),
                abandons_quest: input.get("abandonsQuest").and_then(Value::as_bool).unwrap_or(false),
            };
            block_on(sk_agents::scene_architect::SceneArchitectAgent::new(None).plan(input.get("state").unwrap_or(&Value::Null), &request))
        }
        "campaignScenario" => Ok(optional(sk_scenario::campaign_scenario::campaign_scenario(a(0)).cloned())),
        "scenarioClueFactId" => Ok(Value::String(sk_scenario::campaign_scenario::scenario_clue_fact_id(a(0), a(1).as_str().unwrap_or("")))),
        "scenarioEnding" => Ok(optional(sk_scenario::campaign_scenario::scenario_ending(a(0)))),
        "scenarioLocationId" => Ok(Value::String(sk_scenario::campaign_scenario::scenario_location_id(a(0)))),
        "scenarioForWorldTemplate" => Ok(optional(sk_scenario::campaign_scenario::scenario_for_world_template(a(0).as_str().unwrap_or("")).cloned())),
        "buildScenarioArcPlan" => Ok(sk_scenario::campaign_scenario::build_scenario_arc_plan(a(0))),
        "scenarioSecretsFor" => Ok(Value::Array(sk_scenario::campaign_scenario::scenario_secrets_for(a(0), a(1).as_str().unwrap_or("")))),
        "publicSceneFor" => sk_projection::viewer_projection::public_scene_for(args.first(), args.get(1).filter(|value| !value.is_null())).map_err(fault),
        "campaignStateForViewer" => sk_projection::viewer_projection::campaign_state_for_viewer(args.first(), args.get(1), args.get(2)).map(optional).map_err(fault),
        "partyDecisionOpenedEvent" => sk_memory::party_decision::party_decision_opened_event(a(0), args.get(1).filter(|value| !value.is_null()), a(2)).map_err(fault),
        "resolvePartyVote" => sk_memory::party_decision::resolve_party_vote(a(0), a(1)).map_err(fault),
        "projectionHash" => Ok(Value::String(sk_narration_base::projection_integrity::projection_hash(a(0)))),
        "canonicalProjection" => Ok(sk_narration_base::projection_integrity::canonical_projection(a(0))),
        "compareProjection" => serde_json::to_value(sk_narration_base::projection_integrity::compare_projection(a(0), a(1))).map_err(fault),
        "structuredCommandsFingerprint" => Ok(Value::String(sk_orchestrator::game_orchestrator::structured_commands_fingerprint(args.first()))),
        "narrationRequestFingerprint" => {
            let fields = a(0);
            // Отсутствующее поле — значение по умолчанию JS (`requestKind = 'action'`).
            let defaults = sk_orchestrator::game_orchestrator::RequestFingerprint::default();
            let given = |key: &str| fields.get(key).filter(|value| !value.is_null()).map(|value| js::string(Some(value)));
            let field = |key: &str| given(key).unwrap_or_default();
            let request = sk_orchestrator::game_orchestrator::RequestFingerprint {
                campaign_id: field("campaignId"),
                player_id: field("playerId"),
                message: field("message"),
                npc_id: field("npcId"),
                request_kind: given("requestKind").unwrap_or(defaults.request_kind),
                clarification_id: field("clarificationId"),
                supersedes_check_id: field("supersedesCheckId"),
                supersedes_proposal_id: field("supersedesProposalId"),
                question_check_id: field("questionCheckId"),
                question_proposal_id: field("questionProposalId"),
                operation: field("operation"),
            };
            Ok(Value::String(sk_orchestrator::game_orchestrator::narration_request_fingerprint(&request)))
        }
        "worldClockEventDrafts" => Ok(Value::Array(sk_world_time::weather::world_clock_event_drafts(a(0), a(1)))),
        "findActor" => Ok(optional(sk_core::game::find_actor(a(0), a(1).as_str().unwrap_or("")).cloned())),
        "actorPosition" => Ok(sk_core::game::actor_position(a(0), a(1).as_str().unwrap_or("")).map(|point| json!({ "x": js::num(point.x as f64), "y": js::num(point.y as f64) })).unwrap_or(Value::Null)),
        "footprintCellsFor" => Ok(Value::Array(
            sk_geometry::actor_footprint::footprint_cells_for(args.first().filter(|value| !value.is_null()), args.get(1).filter(|value| !value.is_null())).iter().map(|cell| json!({ "x": cell.x, "y": cell.y })).collect(),
        )),
        "footprintDistanceFeet" => {
            let present = |index: usize| args.get(index).filter(|value| !value.is_null());
            Ok(sk_geometry::actor_footprint::footprint_distance_feet(present(0), present(1), present(2), present(3)).map(js::num).unwrap_or(Value::Null))
        }
        "normalizeWorldMemory" => Ok(sk_memory::world_memory::normalize_world_memory(a(0))),
        "buildCampaignArcPlan" => Ok(sk_story::campaign_loop_policy::build_campaign_arc_plan(args.first(), args.get(1))),
        "experienceForLevel" => sk_character::character_lifecycle::experience_for_level(args.first()).map(Value::from).map_err(fault),
        "clockMinuteOf" => Ok(Value::from(sk_world_time::weather::clock_minute_of(a(0)))),
        "minutesUntilClock" => Ok(Value::from(sk_world_time::weather::minutes_until_clock(a(0), a(1)))),
        "hasClearTrajectory" => {
            let point = |value: &Value| Point { x: value.get("x").and_then(Value::as_f64).unwrap_or(0.0), y: value.get("y").and_then(Value::as_f64).unwrap_or(0.0) };
            Ok(Value::Bool(sk_rules::tactical_geometry::has_clear_trajectory(a(0), point(a(1)), point(a(2)))))
        }
        // `sceneInteractionDefinition({ mapSeed, props, propId })`.
        "sceneInteractionDefinition" => {
            let input = a(0);
            let props = input.get("props").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            Ok(optional(sk_tactical::scene_interactions::scene_interaction_definition(text(input, "mapSeed"), props, input.get("propId"))))
        }
        other => Err(Failure::new("FIXTURE_UNKNOWN", format!("неизвестная функция {other}"))),
    }
}

/// Вход stdin: `[имя, ...аргументы]` или `{ "batch": [[имя, ...], ...] }`.
pub fn run(input: &Value) -> Result<Value, Failure> {
    fn single(call_spec: &Value) -> Result<Value, Failure> {
        let list = call_spec.as_array().filter(|list| list.first().is_some_and(Value::is_string)).ok_or_else(|| Failure::new("FIXTURE_INPUT", "ожидается [имя, ...аргументы]"))?;
        call(list[0].as_str().unwrap_or(""), &list[1..])
    }
    if let Some(batch) = input.get("batch") {
        let calls = batch.as_array().ok_or_else(|| Failure::new("FIXTURE_INPUT", "batch: ожидается список вызовов"))?;
        let results: Result<Vec<Value>, Failure> = calls.iter().map(single).collect();
        let mut output = Map::new();
        output.insert("results".into(), Value::Array(results?));
        return Ok(Value::Object(output));
    }
    single(input)
}

/// Точка входа из `cli.rs`: печатает JSON или ошибку, возвращает код выхода.
pub fn main(args: &[String]) -> i32 {
    if !super::ENABLED {
        eprintln!("skazanie-server fixture: бинарь собран без фичи test-hooks (cargo build --release -p sk-server --features test-hooks)");
        return 2;
    }
    if !args.is_empty() {
        eprintln!("skazanie-server fixture: аргументов нет, вызов — JSON на stdin");
        return 2;
    }
    let mut raw = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut raw) {
        eprintln!("skazanie-server fixture: stdin: {error}");
        return 1;
    }
    let input: Value = match serde_json::from_str(&raw) {
        Ok(input) => input,
        Err(error) => {
            eprintln!("skazanie-server fixture: stdin не JSON: {error}");
            return 2;
        }
    };
    match run(&input) {
        Ok(output) => {
            println!("{}", js::stringify(&output));
            0
        }
        Err(failure) => {
            eprintln!("{}", js::stringify(&failure.to_json()));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_with_door_and_prop_round_trips() {
        let spec = json!({
            "options": { "width": 5, "height": 4, "locationId": "vault", "seed": "lockpick-6", "fill": { "passable": true, "revealed": true } },
            "steps": [
                { "door": { "id": "door", "x": 1, "y": 1, "dir": "e", "state": "locked", "lockDc": 15, "blocksMove": true, "blocksSight": true } },
                { "prop": { "id": "prop-chest", "assetId": "chest", "x": 1.5, "y": 2.5, "footprint": [{ "x": 1, "y": 2 }] } },
                { "cell": [4, 3, { "passable": false }] },
            ],
        });
        let built = call("buildMap", &[spec]).expect("карта");
        assert_eq!(built["map"]["version"], "skazanie:tactical-map-v1");
        assert_eq!(built["map"]["doors"][0]["lockDc"], 15);
        assert_eq!(built["cells"].as_array().map(Vec::len), Some(20));
        let read = call("readMap", &[built["map"].clone()]).expect("чтение");
        let cell = |x: i64, y: i64| read["cells"].as_array().unwrap().iter().find(|cell| cell["x"] == x && cell["y"] == y).cloned().unwrap();
        assert_eq!(cell(4, 3)["passable"], false);
        assert_eq!(cell(0, 0)["passable"], true);
    }

    #[test]
    fn stand_lore_trace_requires_verbatim_material() {
        let material = json!({
            "found": [],
            "heard": [{ "who": "Король Арес", "line": "Саргат сжёг заставу десять дней назад." }],
            "known": [],
        });
        let plan = [json!({ "kind": "heard", "index": 0 })];
        let rendered = sk_agents::lore_voice::render_lore_plan(&plan, &material);
        let checked = |answer: &str| call("matchesRenderedLorePlan", &[json!(answer), material.clone()]).expect("сверка");
        assert_eq!(checked(&rendered), true);
        assert_eq!(checked(&(rendered + " Это сделал король.")), false);
    }

    #[test]
    fn stand_checks_scene_text_against_the_map() {
        let map = call("buildMap", &[json!({
            "options": { "width": 6, "height": 4, "fill": { "passable": true, "revealed": true } },
        })]).expect("карта");
        let checked = call("inspectSceneMap", &[map["map"].clone(), json!("Стоим у колодца."), Value::Null, json!(true)]).expect("сверка");
        assert_eq!(checked["missingObjects"][0]["id"], "well");
        assert_eq!(checked["passableCells"], 24);
        assert_eq!(checked["propCount"], 0);
        assert!(checked["problems"].is_array());
    }

    #[test]
    fn batch_and_refusals() {
        let output = run(&json!({ "batch": [["scenarioClueFactId", { "id": "s" }, "c"], ["materializeCatalogItem", "longsword"]] })).expect("пакет");
        assert_eq!(output["results"].as_array().map(Vec::len), Some(2));
        assert_eq!(run(&json!(["nope"])).unwrap_err().code, "FIXTURE_UNKNOWN");
        assert_eq!(run(&json!({})).unwrap_err().code, "FIXTURE_INPUT");
        let refused = call("resolveCommand", &[json!({ "command_type": "Nope" }), json!({}), json!({})]).unwrap_err();
        assert!(!refused.code.is_empty(), "{refused:?}");
    }
}

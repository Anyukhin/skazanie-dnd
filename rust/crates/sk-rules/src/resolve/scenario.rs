//! Ветки `resolveCommandInternal`: Сценарий: кошель короля, осведомитель, авторский диалог, оружейная, договор, проклятый рыцарь. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 20702–20715, 20716–20749, 20750–20869, 20870–20876, 20877–20912, 20913–20919, 20920–20951. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.
//!
//! Проверка навыка у перевербовки, договора, упокоения и у варианта диалога —
//! вложенный `MakeAbilityCheck` через [`super::resolve_command_internal`] с
//! общими костями: ветка `MakeAbilityCheck` и хвост последствий — задача Р5,
//! полная сверка этих веток с корпусом ждёт её.

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_economy::merchant_economy::{copper_to_currency, currency_to_copper, normalize_currency, normalize_inventory_item, InventoryItemOptions, MAX_CURRENCY_CP};

use super::{Resolve, Resolved};
use crate::command::rules::rule_ids;
use crate::core::{command_with, command_with_rules, event_from, item_granted_event_from, player_actor, slice_utf16, unique_strings};
use crate::dice_record::RulesDice;
use crate::pause::{Fault, Interrupt, Flow};
use crate::society_helpers::npc_departure_events;

fn missing(key: &str) -> Interrupt {
    Fault::type_error(format!("Cannot read properties of null (reading '{key}')")).into()
}

fn field(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

fn at<'a>(value: Option<&'a Value>, path: &[&str]) -> Option<&'a Value> {
    let mut current = value?;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

/// `[command.actor_id]`.
fn actor_targets(command: &Value) -> Value {
    json!([field(command, "actor_id")])
}

/// `[...command.source_rule_ids, …extra]`.
fn rule_list(command: &Value, extra: Option<String>) -> Value {
    let mut ids: Vec<Value> = command.get("source_rule_ids").and_then(Value::as_array).cloned().unwrap_or_default();
    if let Some(extra) = extra {
        ids.push(Value::String(extra));
    }
    Value::Array(ids)
}

/// `{ ...source, command_type: 'MakeAbilityCheck', command_id: `${id}:check`, skill, difficulty, source_rule_ids }`.
fn ability_check_input(source: &Value, command_id: &Value, skill: Option<&Value>, difficulty: Option<&Value>, rules: Value) -> Value {
    let mut input = crate::core::spread_value(Some(source));
    input.insert("command_type".into(), json!("MakeAbilityCheck"));
    input.insert("command_id".into(), json!(format!("{}:check", js::string(Some(command_id)))));
    match skill {
        Some(skill) => input.insert("skill".into(), skill.clone()),
        None => input.shift_remove("skill"),
    };
    match difficulty {
        Some(difficulty) => input.insert("difficulty".into(), difficulty.clone()),
        None => input.shift_remove("difficulty"),
    };
    input.insert("source_rule_ids".into(), rules);
    Value::Object(input)
}

/// `rulesetRuleId(RULE_IDS.abilityCheck, command.ruleset_id)`.
fn ability_check_rule(command: &Value) -> String {
    sk_ruleset::ruleset_config::ruleset_rule_id(rule_ids::ABILITY_CHECK, &js::s(command.get("ruleset_id")))
}

impl Resolve<'_> {
    /// `resolveCommandInternal(input, state, { diceService, context })`:
    /// вложенная команда с общими костями этой команды.
    fn nested(&mut self, input: &Value) -> Result<Resolved, Interrupt> {
        super::resolve_command_internal(input, &self.state, &mut self.dice, &self.context, &mut *self.uuid)
    }

    /// События и броски вложенного разбора — в эту команду.
    fn absorb(&mut self, nested: &Resolved) {
        self.events.extend(nested.events.iter().cloned());
        self.rolls.extend(nested.rolls.iter().cloned());
    }
}

/// `events.find((event) => event.event_type === type)?.payload`.
fn payload_of<'a>(events: &'a [Value], event_type: &str) -> Option<&'a Value> {
    events.iter().find(|event| event.get("event_type").and_then(Value::as_str) == Some(event_type)).and_then(|event| event.get("payload"))
}

/// `…find(AbilityCheckResolved)?.payload?.success === true`.
fn check_succeeded(events: &[Value]) -> bool {
    js::is_true(payload_of(events, "AbilityCheckResolved").and_then(|payload| payload.get("success")))
}

/// `ReceiveScenarioPurse` (20702–20715).
pub fn receive_scenario_purse(r: &mut Resolve<'_>) -> Flow {
    let Some(rules) = sk_scenario::campaign_scenario::scenario_purse_rules(&r.state) else { return Err(missing("dice")) };
    let visibility = r.command.get("visibility").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!("party"));
    let roll = r.dice.roll(&[field(&rules, "dice"), json!("scenario-purse"), field(&r.command, "actor_id"), visibility])?;
    r.rolls.push(roll.clone());
    r.events.push(event_from(&r.command, "DieRolled", Some(roll.clone()), Some(&json!([]))));
    let gold = js::safe_int(roll.get("total"), 0).max(0) as f64 * js::number(rules.get("gold_per_point"));
    let hero = player_actor(&r.state, r.command.get("actor_id"));
    let before = normalize_currency(hero.and_then(|hero| hero.get("currency")));
    let copper = (currency_to_copper(Some(&before)) as f64 + gold * 100.0).min(MAX_CURRENCY_CP as f64);
    let after = copper_to_currency(Some(&js::num(copper)));
    let source = command_with_rules(&r.command, &[rule_ids::ECONOMY_COINS]);
    let targets = actor_targets(&r.command);
    let mut payload = Map::new();
    payload.insert("schema_version".into(), json!(1));
    put(&mut payload, "hero_id", r.command.get("actor_id"));
    put(&mut payload, "roll_total", roll.get("total"));
    payload.insert("gold".into(), js::num(gold));
    payload.insert("currency_before".into(), before);
    payload.insert("currency_after".into(), after);
    r.events.push(event_from(&source, sk_attention::scenario_attention::SCENARIO_PURSE_EVENT, Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}

/// `ResolveScenarioInformant` (20716–20749).
pub fn resolve_scenario_informant(r: &mut Resolve<'_>) -> Flow {
    use sk_attention::scenario_attention::{SCENARIO_INFORMANT_EVENT, SCENARIO_INFORMANT_TURN_FAILED_EVENT};
    let wanted = field(&r.command, "informant_id");
    let Some(informant) = sk_scenario::campaign_scenario::scenario_informant_rules(&r.state).into_iter().find(|entry| entry.get("id") == Some(&wanted)) else {
        return Err(Fault::type_error("Cannot read properties of undefined (reading 'id')").into());
    };
    let targets = actor_targets(&r.command);
    let resolved = |r: &mut Resolve<'_>, outcome: &str, text: Value| {
        let payload = json!({ "schema_version": 1, "informant_id": field(&informant, "id"), "outcome": outcome, "location_id": field(&informant, "location_id"), "text": text });
        r.events.push(event_from(&r.command, SCENARIO_INFORMANT_EVENT, Some(payload), Some(&targets)));
    };
    match r.command.get("choice").and_then(Value::as_str) {
        Some("turn") => {
            let rules = rule_list(&r.command, Some(ability_check_rule(&r.command)));
            let input = ability_check_input(&r.command, &field(&r.command, "command_id"), at(Some(&informant), &["turn", "skill"]), at(Some(&informant), &["turn", "dc"]), rules);
            let check = r.nested(&input)?;
            r.absorb(&check);
            if check_succeeded(&check.events) {
                resolved(r, "turn", field(&informant, "turn_text"));
            } else {
                let payload = json!({ "schema_version": 1, "informant_id": field(&informant, "id"), "text": field(&informant, "turn_failure_text") });
                r.events.push(event_from(&r.command, SCENARIO_INFORMANT_TURN_FAILED_EVENT, Some(payload), Some(&targets)));
            }
        }
        Some("expose") => resolved(r, "expose", field(&informant, "expose_text")),
        _ => resolved(r, "release", field(&informant, "release_text")),
    }
    let outcome = payload_of(&r.events, SCENARIO_INFORMANT_EVENT).and_then(|payload| payload.get("outcome")).cloned();
    let npc_id = js::s(informant.get("npc_id"));
    let departs = outcome.as_ref().is_some_and(|outcome| js::truthy(Some(outcome)) && informant.get("departs_on").and_then(Value::as_array).is_some_and(|list| list.contains(outcome)));
    if !npc_id.is_empty() && departs {
        let departure = npc_departure_events(&r.command, &r.state, &npc_id)?;
        r.events.extend(departure);
    }
    Ok(())
}

/// События с авторским текстом сюжетной сцены (20794–20795).
const AUTHORED_EVENTS: [&str; 7] = [
    sk_world_story::scenario_knight::SCENARIO_KNIGHT_HEAD_EVENT,
    sk_world_story::scenario_knight::SCENARIO_KNIGHT_RELEASED_EVENT,
    sk_world_story::scenario_knight::SCENARIO_KNIGHT_RELEASE_FAILED_EVENT,
    sk_attention::scenario_attention::SCENARIO_INFORMANT_EVENT,
    sk_attention::scenario_attention::SCENARIO_INFORMANT_TURN_FAILED_EVENT,
    sk_attention::scenario_attention::SCENARIO_TREATY_CONCLUDED_EVENT,
    sk_attention::scenario_attention::SCENARIO_TREATY_REFUSED_EVENT,
];

/// `dialogueActionChecks(action)` над действием из команды.
fn action_checks(action: &Value) -> bool {
    match action.get("command_type").and_then(Value::as_str) {
        Some("ReleaseCursedKnight" | "NegotiateScenarioTreaty") => true,
        Some("ResolveScenarioInformant") => action.get("choice").and_then(Value::as_str) == Some("turn"),
        _ => false,
    }
}

/// `{ skill, dc, success, total }` проверки варианта.
fn check_record(option: &Value, events: &[Value]) -> Value {
    let result = payload_of(events, "AbilityCheckResolved").cloned().unwrap_or_else(|| json!({}));
    json!({
        "skill": at(Some(option), &["check", "skill"]).cloned().unwrap_or(Value::Null),
        "dc": at(Some(option), &["check", "dc"]).cloned().unwrap_or(Value::Null),
        "success": js::is_true(result.get("success")),
        "total": js::safe_int(result.get("total"), 0),
    })
}

/// `ChooseDialogueOption` (20750–20869).
pub fn choose_dialogue_option(r: &mut Resolve<'_>) -> Flow {
    let option = field(&r.command, "dialogue_option");
    if !option.is_object() {
        return Err(Fault::type_error("Cannot read properties of undefined (reading 'action')").into());
    }
    let mut plain = crate::core::spread_value(Some(&r.command));
    plain.shift_remove("dialogue_option");
    let plain = Value::Object(plain);
    let command_id = field(&r.command, "command_id");
    let action = option.get("action").filter(|action| js::truthy(Some(action))).cloned();
    let checked_action = action.as_ref().is_some_and(action_checks);
    let mut check: Option<Value> = None;
    let mut action_text = String::new();
    if js::truthy(option.get("check")) && !checked_action {
        let rules = rule_list(&r.command, Some(ability_check_rule(&r.command)));
        let input = ability_check_input(&plain, &command_id, at(Some(&option), &["check", "skill"]), at(Some(&option), &["check", "dc"]), rules);
        let resolved = r.nested(&input)?;
        r.absorb(&resolved);
        check = Some(check_record(&option, &resolved.events));
    }
    if let Some(action) = &action {
        let mut input = Map::new();
        put(&mut input, "command_type", action.get("command_type"));
        put(&mut input, "campaign_id", r.command.get("campaign_id"));
        input.insert("command_id".into(), json!(format!("{}:action", js::string(Some(&command_id)))));
        put(&mut input, "actor_id", r.command.get("actor_id"));
        if let Some(catalog_id) = action.get("catalog_id").filter(|value| js::truthy(Some(value))) {
            input.insert("catalog_id".into(), catalog_id.clone());
        }
        if let Some(informant_id) = action.get("informant_id").filter(|value| js::truthy(Some(value))) {
            input.insert("informant_id".into(), informant_id.clone());
            put(&mut input, "choice", action.get("choice"));
        }
        if checked_action {
            let Some(check_spec) = option.get("check").filter(|value| !value.is_null()) else { return Err(missing("skill")) };
            put(&mut input, "skill", check_spec.get("skill"));
        }
        let acted = r.nested(&Value::Object(input))?;
        r.absorb(&acted);
        if checked_action {
            check = Some(check_record(&option, &acted.events));
        }
        let texts: Vec<String> = acted
            .events
            .iter()
            .filter(|event| event.get("event_type").and_then(Value::as_str).is_some_and(|kind| AUTHORED_EVENTS.contains(&kind)))
            .map(|event| sk_core::text::trim(&js::s(event.get("payload").and_then(|payload| payload.get("text")))).to_string())
            .filter(|text| !text.is_empty())
            .collect();
        action_text = texts.join(" ");
    }
    let succeeded = check.as_ref().is_none_or(|check| js::truthy(check.get("success")));
    let outcome = if succeeded { field(&option, "success") } else { field(&option, "failure") };
    let reply_parts: Vec<String> = [outcome.get("reply").filter(|reply| js::truthy(Some(reply))).map(|reply| js::s(Some(reply))), (!action_text.is_empty()).then(|| action_text.clone())].into_iter().flatten().collect();
    let reply = reply_parts.join(" ");
    let reveal_fact_id = sk_story::campaign_dialogues::dialogue_reveal_fact_id(&r.state, Some(&outcome));
    let revealable = !reveal_fact_id.is_empty();
    let reward_id = if revealable { sk_scenario::campaign_scenario::scenario_clue_reward_catalog_id(&r.state, &reveal_fact_id) } else { None };
    let reward_taken = reward_id.as_ref().filter(|id| !id.is_empty()).is_some_and(|_| {
        let facts = at(r.state.get("worldMemory"), &["facts"]).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        facts.iter().any(|fact| fact.get("predicate").and_then(Value::as_str) == Some("discovery") && js::s(fact.get("supersedes_fact_id")) == reveal_fact_id)
            || sk_story::campaign_dialogues::dialogue_granted_fact_ids(&r.state).contains(&reveal_fact_id)
    });
    let grant_reward = reward_id.as_ref().is_some_and(|id| !id.is_empty()) && !reward_taken;
    let chosen_event_id = format!("dialogue:{}", slice_utf16(&js::string(Some(&command_id)), 100));
    let mut payload = Map::new();
    payload.insert("schema_version".into(), json!(1));
    put(&mut payload, "dialogue_id", option.get("dialogue_id"));
    put(&mut payload, "npc_id", r.command.get("npc_id"));
    put(&mut payload, "npc_name", option.get("npc_name"));
    put(&mut payload, "option_id", option.get("id"));
    put(&mut payload, "hero_id", r.command.get("actor_id"));
    put(&mut payload, "label", option.get("label"));
    payload.insert("reply".into(), json!(reply));
    payload.insert("check".into(), check.clone().unwrap_or(Value::Null));
    payload.insert("sets".into(), outcome.get("sets").and_then(Value::as_array).cloned().map(Value::Array).unwrap_or_else(|| json!([])));
    let reveal = if revealable { outcome.get("reveal").filter(|value| js::truthy(Some(value))).cloned().unwrap_or(Value::Null) } else { Value::Null };
    payload.insert("reveal".into(), reveal);
    if revealable {
        if let Some(topic) = outcome.get("reveal_topic").filter(|value| js::truthy(Some(value))) {
            payload.insert("reveal_topic".into(), topic.clone());
        }
        payload.insert("revealed_fact_id".into(), json!(reveal_fact_id));
    }
    if grant_reward {
        payload.insert("granted_fact_id".into(), json!(reveal_fact_id));
    }
    payload.insert("ends".into(), json!(js::is_true(option.get("ends"))));
    let pair = json!([field(&r.command, "npc_id"), field(&r.command, "actor_id")]);
    let mut chosen = event_from(&r.command, sk_story::campaign_dialogues::DIALOGUE_EVENT, Some(Value::Object(payload)), Some(&pair));
    chosen["event_id"] = json!(chosen_event_id);
    r.events.push(chosen);
    let social_skill = check.as_ref().filter(|check| check.get("skill").and_then(Value::as_str).is_some_and(|skill| ["persuasion", "deception", "intimidation", "insight"].contains(&skill)));
    let mut conversation = Map::new();
    conversation.insert("id".into(), json!(format!("conversation:dialogue:{}", slice_utf16(&js::string(Some(&command_id)), 90))));
    put(&mut conversation, "npc_id", r.command.get("npc_id"));
    put(&mut conversation, "hero_id", r.command.get("actor_id"));
    put(&mut conversation, "player_message", option.get("label"));
    conversation.insert("npc_reply".into(), json!(reply));
    conversation.insert("stance".into(), json!("neutral"));
    conversation.insert("disclosed_fact_ids".into(), if revealable { json!([reveal_fact_id]) } else { json!([]) });
    conversation.insert("disclosed_claim_ids".into(), json!([]));
    conversation.insert("visibility".into(), json!("party"));
    if let Some(check) = social_skill {
        conversation.insert("check".into(), json!({ "skill": field(check, "skill"), "success": field(check, "success"), "total": field(check, "total") }));
    }
    r.events.push(event_from(&r.command, "NpcConversationRecorded", Some(json!({ "conversation": Value::Object(conversation) })), Some(&pair)));
    if grant_reward {
        let reward = reward_id.unwrap_or_default();
        let item = sk_items::item_catalog::materialize_catalog_item(&reward, Some(&json!({ "quantity": 1, "origin": "gifted" })));
        let fallback = format!("scenario-reward:{reveal_fact_id}");
        let item = normalize_inventory_item(Some(&item), InventoryItemOptions { id_fallback: &fallback, preserve_unknown: true, hydrate_catalog: false });
        let targets = actor_targets(&r.command);
        r.events.push(item_granted_event_from(&r.command, Some(json!({ "item": item })), Some(&targets)));
    }
    if revealable {
        let mut members = vec![field(&r.command, "actor_id")];
        members.extend(r.state.get("partyMemberIds").and_then(Value::as_array).cloned().unwrap_or_default());
        let party = js::strings_value(unique_strings(Some(&Value::Array(members))));
        let payload = json!({
            "knowledge_id": format!("{chosen_event_id}:knowledge"),
            "hero_id": field(&r.command, "actor_id"),
            "fact_id": reveal_fact_id,
            "source_event_ids": [chosen_event_id],
            "source_kind": "npc",
            "revealed_at_minutes": js::num(sk_social::npc_social::campaign_elapsed_minutes(&r.state)),
        });
        r.events.push(event_from(&r.command, "KnowledgeRevealed", Some(payload), Some(&party)));
    }
    Ok(())
}

/// `ChooseScenarioArmoryItem` (20870–20876).
pub fn choose_scenario_armory_item(r: &mut Resolve<'_>) -> Flow {
    let item = field(&r.command, "armory_item");
    let targets = actor_targets(&r.command);
    r.events.push(item_granted_event_from(&r.command, Some(json!({ "item": item })), Some(&targets)));
    if item.is_null() {
        return Err(missing("name"));
    }
    let mut payload = Map::new();
    payload.insert("schema_version".into(), json!(1));
    put(&mut payload, "hero_id", r.command.get("actor_id"));
    put(&mut payload, "catalog_id", r.command.get("catalog_id"));
    put(&mut payload, "item_name", item.get("name"));
    r.events.push(event_from(&r.command, sk_attention::scenario_attention::SCENARIO_ARMORY_EVENT, Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}

/// `{ schema_version: 1, npc_id, skill: command.skill, …rest }`.
fn scenario_payload(command: &Value, npc_id: &Value, rest: &[(&str, Value)]) -> Value {
    let mut payload = Map::new();
    payload.insert("schema_version".into(), json!(1));
    payload.insert("npc_id".into(), npc_id.clone());
    put(&mut payload, "skill", command.get("skill"));
    for (key, value) in rest {
        payload.insert((*key).into(), value.clone());
    }
    Value::Object(payload)
}

/// `NegotiateScenarioTreaty` (20877–20912).
pub fn negotiate_scenario_treaty(r: &mut Resolve<'_>) -> Flow {
    use sk_attention::scenario_attention::{SCENARIO_TREATY_CONCLUDED_EVENT, SCENARIO_TREATY_REFUSED_EVENT};
    let rules = sk_scenario::campaign_scenario::scenario_treaty_rules(&r.state);
    let input = ability_check_input(&r.command, &field(&r.command, "command_id"), r.command.get("skill"), r.command.get("difficulty"), rule_list(&r.command, None));
    let check = r.nested(&input)?;
    r.absorb(&check);
    let Some(rules) = rules else { return Err(missing("boss_npc_id")) };
    let boss = field(&rules, "boss_npc_id");
    let pair = json!([boss, field(&r.command, "actor_id")]);
    if !check_succeeded(&check.events) {
        let payload = scenario_payload(&r.command, &boss, &[("text", field(&rules, "failure_text"))]);
        r.events.push(event_from(&r.command, SCENARIO_TREATY_REFUSED_EVENT, Some(payload), Some(&pair)));
        return Ok(());
    }
    let payload = scenario_payload(&r.command, &boss, &[("text", field(&rules, "success_text"))]);
    r.events.push(event_from(&r.command, SCENARIO_TREATY_CONCLUDED_EVENT, Some(payload), Some(&pair)));
    if sk_core::game::combat_active(&r.state) {
        let enemies: Vec<Value> = r.state.get("enemies").and_then(Value::as_array).cloned().unwrap_or_default();
        for enemy in enemies.iter().filter(|enemy| sk_core::game::is_living_actor(enemy)) {
            let id = sk_core::game::actor_id(enemy);
            let source = command_with_rules(&command_with(&r.command, "actor_id", json!(id)), &[rule_ids::CONDITIONS]);
            let targets = json!([id]);
            r.events.push(event_from(&source, "ConditionAdded", Some(json!({ "condition": "fled", "source_actor": id, "source": "scenario-treaty" })), Some(&targets)));
        }
    } else {
        let departure = npc_departure_events(&r.command, &r.state, &js::s(Some(&boss)))?;
        r.events.extend(departure);
    }
    Ok(())
}

/// `ReturnKnightHead` (20913–20919).
pub fn return_knight_head(r: &mut Resolve<'_>) -> Flow {
    let Some(rules) = sk_world_story::scenario_knight::scenario_knight_rules(&r.state) else { return Err(missing("npc_id")) };
    let npc_id = field(&rules, "npc_id");
    let source = command_with_rules(&r.command, &[rule_ids::TURNS]);
    let payload = json!({ "schema_version": 1, "npc_id": npc_id, "action_spent": sk_core::game::combat_active(&r.state), "text": field(&rules, "head_text") });
    let targets = json!([npc_id]);
    r.events.push(event_from(&source, sk_world_story::scenario_knight::SCENARIO_KNIGHT_HEAD_EVENT, Some(payload), Some(&targets)));
    Ok(())
}

/// `ReleaseCursedKnight` (20920–20951).
pub fn release_cursed_knight(r: &mut Resolve<'_>) -> Flow {
    use sk_world_story::scenario_knight::{SCENARIO_KNIGHT_RELEASED_EVENT, SCENARIO_KNIGHT_RELEASE_FAILED_EVENT};
    let Some(rules) = sk_world_story::scenario_knight::scenario_knight_rules(&r.state) else { return Err(missing("release")) };
    let difficulty = at(Some(&rules), &["release", "dc"]).cloned();
    let input = ability_check_input(&r.command, &field(&r.command, "command_id"), r.command.get("skill"), difficulty.as_ref(), rule_list(&r.command, None));
    let check = r.nested(&input)?;
    r.absorb(&check);
    let npc_id = field(&rules, "npc_id");
    let pair = json!([npc_id, field(&r.command, "actor_id")]);
    if check_succeeded(&check.events) {
        let payload = scenario_payload(&r.command, &npc_id, &[("text", at(Some(&rules), &["release", "success_text"]).cloned().unwrap_or(Value::Null))]);
        r.events.push(event_from(&r.command, SCENARIO_KNIGHT_RELEASED_EVENT, Some(payload), Some(&pair)));
        let mut grant = Map::new();
        grant.insert("item".into(), field(&r.command, "reward_item"));
        if let Some(source) = r.command.get("reward_source_npc_id").filter(|value| js::truthy(Some(value))) {
            grant.insert("source_npc_id".into(), source.clone());
        }
        let targets = actor_targets(&r.command);
        r.events.push(item_granted_event_from(&r.command, Some(Value::Object(grant)), Some(&targets)));
        let departure = npc_departure_events(&r.command, &r.state, &js::s(Some(&npc_id)))?;
        r.events.extend(departure);
    } else {
        let night = js::num(sk_world_story::scenario_knight::scenario_night_index(&r.state));
        let payload = scenario_payload(&r.command, &npc_id, &[("night", night), ("text", at(Some(&rules), &["release", "failure_text"]).cloned().unwrap_or(Value::Null))]);
        r.events.push(event_from(&r.command, SCENARIO_KNIGHT_RELEASE_FAILED_EVENT, Some(payload), Some(&pair)));
    }
    Ok(())
}

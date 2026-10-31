//! Предпросмотр d20 (`previewD20Check`, `previewTavernDiceRoll`), отказы
//! почты (`assertSendLetterAllowed`) и зверя (`validatedBeastTarget`), отказ
//! молитвы у святыни (`shrinePrayerRefusalFor`) и события благословения
//! (`blessingGrantedEvents`). Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 6064–6152, 11760–11859, 11959–12058.
//!
//! Предпросмотр — то, что игрок видит на карточке ручного броска: модификатор
//! и режим кубиков считаются теми же функциями, что и исполнение команды.
//! Параметры JS-деструктуризации (`{ actorId, kind = 'check', … }`) приходят
//! JSON-объектом: значение по умолчанию действует только для отсутствующего
//! ключа (`undefined`), как в JS.

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_core::text;

use crate::checks::saves::{bloodied_frenzy_save_advantage, check_disadvantage_condition_for, saving_throw_modifier_with_aura, weather_check_swing_for};
use crate::checks::skills::{canonical_skill_id, saving_throw_modifier_for_actor, skill_proficiency_for_actor};
use crate::command::rules::rule_ids;
use crate::conditions::{check_advantage_condition_for, save_advantage_condition_for, save_disadvantage_condition_for};
use crate::core::{ability_modifier, armor_stealth_disadvantage, command_with, command_with_rules, condition_ids_for, event_from, player_actor, slice_utf16};
use crate::pause::{rule, Fault, Halt};

fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

/// Значение параметра или JS-умолчание для `undefined`.
fn option_or<'a>(options: &'a Value, key: &str, fallback: &'a Value) -> &'a Value {
    options.get(key).unwrap_or(fallback)
}

/// `String(x).toLowerCase()`.
fn lower_string(value: &Value) -> String {
    js::string(Some(value)).to_lowercase()
}

/// `previewD20Check(state, { actorId, kind = 'check', ability = null, skill = null, difficulty = 10, proficient = false })`.
pub fn preview_d20_check(state: &Value, options: &Value) -> Result<Value, Halt> {
    let null = Value::Null;
    let ten = Value::from(10);
    let check = Value::String("check".into());
    let actor_id = options.get("actorId");
    let kind = option_or(options, "kind", &check);
    let ability = option_or(options, "ability", &null);
    let skill = option_or(options, "skill", &null);
    let difficulty = option_or(options, "difficulty", &ten);
    let proficient = js::truthy(options.get("proficient"));
    let actor = sk_core::game::find_actor(state, &js::s(actor_id));
    // `conditionIdsFor(state, id)` и `state.mechanics.conditions[id]` берут `String(id)`.
    let id = js::string(actor_id);
    let proficiency_bonus = |actor: Option<&Value>| if proficient { js::safe_int(field(actor, "proficiency"), 0) } else { 0 };
    if kind.as_str() == Some("save") {
        let save_ability = if js::truthy(Some(ability)) { lower_string(ability) } else { "con".to_string() };
        let save_value = Value::String(save_ability.clone());
        let current = ability_modifier(field(field(actor, "abilities"), &save_ability)) + proficiency_bonus(actor);
        let base_modifier = saving_throw_modifier_for_actor(actor, Some(&save_value), Some(&Value::from(current)), Some(state), !proficient);
        let aura = saving_throw_modifier_with_aura(state, &id, Some(&Value::from(base_modifier)))?;
        let advantage = save_advantage_condition_for(state, &id, Some(&save_value)).is_some() || condition_ids_for(state, &id).contains("silvery-fortune") || bloodied_frenzy_save_advantage(state, &id);
        let mut preview = Map::new();
        preview.insert("kind".into(), Value::String("save".into()));
        preview.insert("ability".into(), save_value.clone());
        preview.insert("skill".into(), Value::Null);
        preview.insert("modifier".into(), js::num(aura.modifier));
        preview.insert("difficulty".into(), Value::from(js::safe_int(Some(difficulty), 10)));
        preview.insert("advantage".into(), Value::Bool(advantage));
        preview.insert("disadvantage".into(), Value::Bool(save_disadvantage_condition_for(state, &id, Some(&save_value)).is_some()));
        return Ok(Value::Object(preview));
    }
    let check_skill = canonical_skill_id(Some(skill));
    let skill_value = Value::String(check_skill.clone());
    let from_skill = sk_ruleset::character_progression::skill_ability(Some(&skill_value)).filter(|value| js::truthy(Some(value)));
    let check_ability = match from_skill {
        Some(value) => lower_string(&value),
        None if js::truthy(Some(ability)) => lower_string(ability),
        None => "str".to_string(),
    };
    let ability_value = Value::String(check_ability.clone());
    let proficiency = if check_skill.is_empty() { Value::Null } else { skill_proficiency_for_actor(actor, Some(&skill_value), Some(state)) };
    let bonus = match proficiency.get("bonus").filter(|value| !value.is_null()) {
        Some(bonus) => js::number(Some(bonus)),
        None => proficiency_bonus(actor) as f64,
    };
    let tavern = sk_npc_world::tavern_life::tavern_social_bonus(state, actor_id.unwrap_or(&null), Some(&skill_value));
    let modifier = ability_modifier(field(field(actor, "abilities"), &check_ability)) as f64 + bonus + tavern as f64;
    let weather_swing = weather_check_swing_for(state, Some(&skill_value), actor_id);
    let watch_swing = sk_npc_world::beast_taming::beast_watch_swing(state, Some(&skill_value), actor_id);
    let swing = |value: &Option<Value>, wanted: &str| value.as_ref().and_then(|value| value.get("swing")).and_then(Value::as_str) == Some(wanted);
    let advantage = check_advantage_condition_for(state, &id, Some(&ability_value)).is_some() || condition_ids_for(state, &id).contains("silvery-fortune") || swing(&weather_swing, "advantage") || watch_swing.is_some();
    let disadvantage = check_disadvantage_condition_for(state, &id, Some(&ability_value)).is_some() || (check_skill == "stealth" && armor_stealth_disadvantage(actor)) || swing(&weather_swing, "disadvantage");
    let mut preview = Map::new();
    preview.insert("kind".into(), Value::String("check".into()));
    preview.insert("ability".into(), ability_value);
    preview.insert("skill".into(), if check_skill.is_empty() { Value::Null } else { skill_value });
    preview.insert("modifier".into(), js::num(modifier));
    preview.insert("difficulty".into(), Value::from(js::safe_int(Some(difficulty), 10)));
    preview.insert("advantage".into(), Value::Bool(advantage));
    preview.insert("disadvantage".into(), Value::Bool(disadvantage));
    if let Some(weather) = &weather_swing {
        preview.insert("weather_reason".into(), weather.get("reason").cloned().unwrap_or(Value::Null));
    }
    if let Some(watch) = &watch_swing {
        preview.insert("beast_watch_reason".into(), watch.get("reason").cloned().unwrap_or(Value::Null));
    }
    Ok(Value::Object(preview))
}

/// `previewTavernDiceRoll(state, actorId, approach = 'fair')`: ответный бросок
/// за костями. `approach: None` — `undefined` (умолчание `fair`).
pub fn preview_tavern_dice_roll(state: &Value, actor_id: Option<&Value>, approach: Option<&Value>) -> Value {
    let round = sk_npc_world::tavern_life::tavern_round_for(state, actor_id.unwrap_or(&Value::Null));
    let penalty = check_disadvantage_condition_for(state, &js::string(actor_id), None);
    let approach = approach.map_or_else(|| "fair".to_string(), |value| js::string(Some(value)));
    let mut preview = Map::new();
    preview.insert("kind".into(), Value::String("check".into()));
    preview.insert("ability".into(), Value::Null);
    preview.insert("skill".into(), Value::Null);
    preview.insert("modifier".into(), Value::from(if approach == "cheat" { sk_npc_world::tavern_life::TAVERN_CHEAT_BONUS } else { 0 }));
    preview.insert("difficulty".into(), round.map_or(Value::from(11), |round| round.to_json().get("target").cloned().unwrap_or(Value::Null)));
    preview.insert("advantage".into(), Value::Bool(false));
    preview.insert("disadvantage".into(), Value::Bool(penalty.is_some()));
    if let Some(penalty) = penalty {
        preview.insert("check_disadvantage_condition".into(), Value::String(penalty));
    }
    Value::Object(preview)
}

/// `assertSendLetterAllowed(state, command)` (6064–6094): все отказы почты до
/// первого события; возвращает адресата. Состояние — нормализованное.
pub fn assert_send_letter_allowed(state: &Value, command: &Value) -> Result<Value, Halt> {
    use sk_world_life::courier_letters::{courier_addressee_for, open_courier_letters_for, COURIER_LETTER_OPEN_LIMIT};
    if sk_core::game::combat_active(state) {
        return Err(rule("Посреди боя писем не пишут", "COURIER_DURING_COMBAT"));
    }
    let actor_id = command.get("actor_id");
    let Some(hero) = player_actor(state, actor_id) else {
        return Err(rule("Письмо пишет герой отряда", "ACTOR_FORBIDDEN"));
    };
    if !sk_core::game::find_actor(state, &js::s(actor_id)).is_some_and(sk_core::game::is_living_actor) {
        return Err(rule("Герой без сознания писем не пишет", "ACTOR_DEFEATED"));
    }
    if text::trim(&js::s(command.get("body"))).is_empty() {
        return Err(rule("Пустое письмо курьер не повезёт", "COURIER_LETTER_EMPTY"));
    }
    let Some(addressee) = courier_addressee_for(state, command.get("addressee_kind"), command.get("addressee_id"), None).filter(|value| js::truthy(Some(value))) else {
        return Err(rule("Такого адресата отряд не знает", "COURIER_ADDRESSEE_NOT_FOUND"));
    };
    if js::truthy(addressee.get("unreachable")) {
        return Err(rule("Адресат стоит перед отрядом: это разговор, а не письмо", "COURIER_ADDRESSEE_PRESENT"));
    }
    if open_courier_letters_for(state, actor_id).len() as i64 >= COURIER_LETTER_OPEN_LIMIT {
        return Err(rule("У героя и так слишком много писем в дороге", "COURIER_TOO_MANY_LETTERS"));
    }
    if (sk_economy::merchant_economy::currency_to_copper(hero.get("currency")) as f64) < js::number(addressee.get("fee_cp")) {
        return Err(rule("На курьера не хватает монет", "INSUFFICIENT_FUNDS"));
    }
    Ok(addressee)
}

/// `catalogItem` как распознаватель каталога для `beastFoodItemFor`.
pub fn catalog_item_owned(catalog_id: &str) -> Option<Value> {
    sk_items::item_catalog::catalog_item(catalog_id).cloned()
}

/// `validatedBeastTarget(state, command)` (6109–6152): зверь команды и всё,
/// что проверяется раньше первого события; `{ beast_actor_id }`.
pub fn validated_beast_target(state: &Value, command: &Value) -> Result<Value, Halt> {
    use sk_npc_world::beast_taming::{beast_food_item_for, beast_for, beast_id_for, beast_out_of_reach, beast_scare_cooldown_left, tameable_beasts};
    let command_type = js::s(command.get("command_type"));
    let beast_id = command.get("beast_id");
    let registered = beast_for(state, beast_id);
    let minutes = || js::num(sk_social::npc_social::campaign_elapsed_minutes(state));
    if command_type == "ScareWithBeast" {
        let Some(registered) = registered.filter(|beast| beast.get("status").and_then(Value::as_str) == Some("companion")) else {
            return Err(rule("Отогнать угрозу может только прирученный спутник", "BEAST_NOT_COMPANION"));
        };
        if sk_core::game::combat_active(state) {
            return Err(rule("В бою зверь не отгоняет: это не боевой спутник", "BEAST_DURING_COMBAT"));
        }
        if beast_scare_cooldown_left(Some(&registered), Some(&minutes())) > 0 {
            return Err(rule("Зверь только что отогнал одну тварь и на вторую пока не встанет", "BEAST_SCARE_COOLDOWN"));
        }
        return Ok(json!({ "beast_actor_id": registered.get("actor_id").cloned().unwrap_or(Value::Null) }));
    }
    // `(entry.beast?.id ?? beastIdFor(state, entry.enemy.id)) === command.beast_id`.
    let candidate = tameable_beasts(state).into_iter().find(|entry| {
        let id = match field(entry.beast.as_ref(), "id").filter(|value| !value.is_null()) {
            Some(id) => id.clone(),
            None => Value::String(beast_id_for(state, entry.enemy.get("id"))),
        };
        Some(&id) == beast_id
    });
    let Some(candidate) = candidate else {
        return Err(rule("Такого зверя рядом нет", "BEAST_NOT_FOUND"));
    };
    if candidate.blocked_reason == Some("beast_down") {
        return Err(rule("Зверь уже не на ногах", "BEAST_DOWN"));
    }
    if candidate.blocked_reason == Some("combat_active") {
        return Err(rule("Посреди боя зверя не уговаривают: сначала он должен сломаться", "BEAST_DURING_COMBAT"));
    }
    let stage = match field(candidate.beast.as_ref(), "stage").filter(|value| !value.is_null()) {
        Some(stage) => stage.clone(),
        None => Value::String("wary".into()),
    };
    if command_type == "FeedBeast" && stage.as_str() != Some("calmed") {
        let message = if stage.as_str() == Some("wary") { "С руки едят только успокоенные: сначала уговор" } else { "Этот зверь уже поел с руки" };
        return Err(rule(message, "BEAST_STAGE_MISMATCH"));
    }
    if command_type == "CalmBeast" && stage.as_str() == Some("calmed") {
        return Err(rule("Зверь успокоен и ждёт еды, а не второго уговора", "BEAST_STAGE_MISMATCH"));
    }
    if command_type == "FeedBeast" && beast_food_item_for(player_actor(state, command.get("actor_id")), Some(&catalog_item_owned)).is_none() {
        return Err(rule("Кормить нечем: в рюкзаке нет ни пайка, ни другой снеди", "BEAST_NO_FOOD"));
    }
    if beast_out_of_reach(state, command.get("actor_id"), candidate.enemy.get("id")) {
        return Err(rule("До зверя нужно дойти: протянуть руку можно только вплотную", "BEAST_OUT_OF_REACH"));
    }
    Ok(json!({ "beast_actor_id": js::string(candidate.enemy.get("id")) }))
}

/// Отказ молитвы: `{ code, message }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShrineRefusal {
    pub code: &'static str,
    pub message: &'static str,
}

impl ShrineRefusal {
    pub fn to_json(&self) -> Value {
        json!({ "code": self.code, "message": self.message })
    }
}

/// `shrinePrayerRefusalFor(state, { actorId = '', propId = '' })`: почему
/// молиться у этой святыни нельзя — либо `None`. `ensureSceneTacticalMap`
/// пишет карту в состояние, поэтому функция работает над копией; ошибка
/// карты (`TacticalMapError` JS) — `Fault` с её кодом.
pub fn shrine_prayer_refusal_for(state: &Value, actor_id: &Value, prop_id: &Value) -> Result<Option<ShrineRefusal>, Halt> {
    let refuse = |code: &'static str, message: &'static str| Ok(Some(ShrineRefusal { code, message }));
    if js::truthy(field(field(field(Some(state), "mechanics"), "combat"), "active")) {
        return refuse("BLESSING_DURING_COMBAT", "Посреди боя благословений не раздают");
    }
    let mut working = state.clone();
    let map = sk_tactical::combat_bounds::ensure_scene_tactical_map(&mut working).map_err(|error| Halt::Fault(Fault::new(error.name, error.message).with_code(error.code)))?;
    let Some(map) = map else {
        return refuse("TACTICAL_MAP_REQUIRED", "Для объекта нужна тактическая карта");
    };
    let wanted = js::string(Some(prop_id));
    let props: Vec<Value> = map.props.iter().map(|prop| prop.to_json()).collect();
    let Some(prop) = props.iter().find(|candidate| js::string(candidate.get("id")) == wanted) else {
        return refuse("SCENE_OBJECT_NOT_FOUND", "Такого объекта нет на карте");
    };
    if !js::is_true(prop.get("interactive")) {
        return refuse("SCENE_OBJECT_NOT_INTERACTIVE", "Этот объект не отмечен как интерактивный");
    }
    let Some(definition) = sk_tactical::scene_interactions::scene_interaction_definition(&map.seed, &props, prop.get("id")).filter(|value| js::truthy(Some(value))) else {
        return refuse("SCENE_OBJECT_UNSUPPORTED", "Для этого объекта нет серверного правила взаимодействия");
    };
    let prays = definition.get("verbs").and_then(Value::as_array).is_some_and(|verbs| verbs.iter().any(|verb| verb.as_str() == Some("pray")));
    if !prays || !sk_tactical::scene_interactions::is_scene_shrine_asset(prop.get("assetId")) {
        return refuse("SCENE_OBJECT_INTENT_NOT_ALLOWED", "Молиться можно только у святыни");
    }
    let id = js::s(Some(actor_id));
    let Some(at) = sk_core::game::actor_position(&working, &id) else {
        return refuse("MAP_POSITION_REQUIRED", "Участник должен находиться на карте");
    };
    if crate::geometry::footprint::actor_object_distance_cells(&working, &id, prop, Some(sk_geometry::Point { x: at.x as f64, y: at.y as f64 })) > 1.0 {
        return refuse("SCENE_OBJECT_OUT_OF_REACH", "До объекта нужно дотянуться: встаньте вплотную");
    }
    if !sk_core::game::find_actor(&working, &id).is_some_and(sk_core::game::is_living_actor) {
        return refuse("ACTOR_DEFEATED", "Взаимодействовать может только дееспособный участник");
    }
    let minutes = js::num(sk_social::npc_social::campaign_elapsed_minutes(&working));
    if !sk_npc_world::blessings::blessing_availability_for(&working, actor_id, Some(&minutes)).available {
        return refuse("BLESSING_ALREADY_TODAY", "Этот герой уже обращался к богам сегодня");
    }
    if sk_npc_world::blessings::hero_is_blessed(&working, actor_id) {
        return refuse("BLESSING_ALREADY_ACTIVE", "Благословение этого героя ещё не израсходовано");
    }
    Ok(None)
}

/// Параметры `blessingGrantedEvents(command, state, { … })`.
#[derive(Debug, Clone, Default)]
pub struct BlessingGrant {
    pub hero_id: Value,
    /// `priest` или `shrine`.
    pub source: String,
    pub place_name: String,
    pub npc_id: String,
    pub npc_name: String,
    pub minutes: Value,
    pub source_event_id: String,
}

/// `String(scene.location ?? scene.title ?? '')`.
pub fn scene_place_text(state: &Value) -> String {
    let scene = state.get("scene");
    match crate::core::coalesce(&[field(scene, "location"), field(scene, "title")]) {
        Some(value) => js::s(Some(value)),
        None => String::new(),
    }
}

/// `blessingGrantedEvents(command, state, options)` (12015–12058): состояние
/// благословения и факт мира о месте.
pub fn blessing_granted_events(command: &Value, state: &Value, grant: &BlessingGrant) -> Vec<Value> {
    use sk_npc_world::blessings::{BLESSING_ATTACK_BONUS, BLESSING_CONDITION, BLESSING_DURATION};
    let mut events = Vec::new();
    let hero_id = &grant.hero_id;
    let hero = player_actor(state, Some(hero_id));
    let hero_name = match crate::conditions::nullish_chain(&[field(hero, "character"), field(hero, "name")]).filter(|value| !value.is_null()) {
        Some(name) => slice_utf16(&js::s(Some(name)), 120),
        None => slice_utf16(&js::string(Some(hero_id)), 120),
    };
    let hero_key = js::string(Some(hero_id));
    let party = command_with(command, "visibility", Value::String("party".into()));
    if !condition_ids_for(state, &hero_key).contains(BLESSING_CONDITION) {
        let source = command_with_rules(&party, &[rule_ids::CONDITIONS]);
        let payload = json!({ "condition": BLESSING_CONDITION, "duration": BLESSING_DURATION, "source": format!("blessing:{}", grant.source), "attack_bonus": BLESSING_ATTACK_BONUS });
        events.push(event_from(&source, "ConditionAdded", Some(payload), Some(&json!([hero_id]))));
    }
    let place_key = text::lower(&text::squash_spaces(&text::nfkc(&scene_place_text(state))));
    let entities = field(state.get("worldMemory"), "entities").and_then(Value::as_array).cloned().unwrap_or_default();
    let place_entity = entities.iter().find(|entity| js::s(field(Some(entity), "kind")) == "location" && text::lower(&js::s(field(Some(entity), "name"))) == place_key);
    let where_text = if grant.source == "priest" {
        if grant.npc_name.is_empty() { "у служителя храма".to_string() } else { format!("от кого: {}", grant.npc_name) }
    } else if grant.place_name.is_empty() {
        "у придорожной святыни".to_string()
    } else {
        format!("место: {}", grant.place_name)
    };
    if let Some(entity) = place_entity {
        let minutes = js::safe_int(Some(&grant.minutes), 0).max(0);
        let mut fact = Map::new();
        fact.insert("id".into(), Value::String(format!("fact:blessing:{}:{minutes}", slice_utf16(&hero_key, 60))));
        fact.insert("subject_id".into(), Value::String(js::string(entity.get("id"))));
        fact.insert("predicate".into(), Value::String(if grant.source == "priest" { "blessed_by_priest" } else { "blessed_at_shrine" }.into()));
        fact.insert("object".into(), Value::String(slice_utf16(&hero_key, 180)));
        fact.insert("summary".into(), Value::String(format!("{hero_name} принял(а) малое благословение ({where_text}).")));
        fact.insert("visibility".into(), Value::String("party".into()));
        if !grant.source_event_id.is_empty() {
            fact.insert("source_event_ids".into(), json!([grant.source_event_id]));
        }
        fact.insert("status".into(), Value::String("active".into()));
        fact.insert("recorded_at_minutes".into(), Value::from(minutes));
        events.push(event_from(&party, "WorldFactRecorded", Some(json!({ "fact": Value::Object(fact) })), Some(&json!([]))));
    }
    events
}

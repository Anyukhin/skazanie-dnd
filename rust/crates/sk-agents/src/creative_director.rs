//! Перенос `server/creative-director.mjs`: творческий режиссёр
//! (`CriticalNarrationCoordinator`) — только текст критического момента после
//! commit. Механики не касается: ОЗ, броски и позиции он не меняет, а
//! рассказывает уже подтверждённое событиями.
//!
//! Рассказчик внедряется трейтом [`CriticalNarrator`] (`narrator.render(brief,
//! options)` в JS; реализует его рассказчик, задача А5). Без живого текста
//! модели (`provider` начинается с `deterministic`) звучит короткая
//! детерминированная реплика о моменте ([`critical_moment_line`]).

use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_agents_base::llm_client::{LlmError, LlmFuture};
use sk_core::indexmap::IndexSet;
use sk_core::{hash, js, re, text};
use sk_encounters::agent_context::{campaign_concept_for_agent, field_summary_for, hero_card_for_agent};
use sk_tactics::security::{build_narration_brief, SecurityValidationError};

/// Потолок ожидания для необязательного текста критического момента: ниже
/// общего таймаута модели (9 с), ход не может зависнуть.
pub const CRITICAL_NARRATION_TIMEOUT_MS: i64 = 8_000;

/// Рассказчик, которому координатор отдаёт бриф (`narrator.render`).
/// `options` — `{ knownRuleIds, timeoutMs, recentNarrations, style }`; ответ —
/// объект рассказа `{ narration, provider, … }`.
pub trait CriticalNarrator: Send + Sync {
    fn render<'a>(&'a self, brief: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>>;
}

impl<T: CriticalNarrator + ?Sized> CriticalNarrator for Arc<T> {
    fn render<'a>(&'a self, brief: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        (**self).render(brief, options)
    }
}

/// Исключение, которое в JS вылетело бы из метода координатора.
#[derive(Debug, Clone)]
pub enum CriticalNarrationError {
    /// `buildNarrationBrief` отверг бриф.
    Security(SecurityValidationError),
    /// `narrator.render` бросил.
    Render(LlmError),
}

impl std::fmt::Display for CriticalNarrationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Security(error) => write!(formatter, "{}: {}", error.name, error.message),
            Self::Render(error) => write!(formatter, "{}: {}", error.name, error.message),
        }
    }
}

impl std::error::Error for CriticalNarrationError {}

type Outcome = Result<Option<Value>, CriticalNarrationError>;

// --- приведения ----------------------------------------------------------------------

fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        None | Some(Value::Null) => second,
        some => some,
    }
}

/// `value?.[0]`: элемент массива или первая буква строки.
fn index0(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Array(items)) => items.first().cloned(),
        Some(Value::String(chars)) => chars.encode_utf16().next().map(|unit| Value::String(String::from_utf16_lossy(&[unit]))),
        _ => None,
    }
}

fn list(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn s(value: Option<&Value>) -> String {
    js::s(value)
}

fn string(text: impl Into<String>) -> Value {
    Value::String(text.into())
}

/// `{ ...value }`: объект — его поля, строка — буквы по индексам (как в JS),
/// иное — пусто.
fn spread(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::String(chars)) => {
            let units: Vec<u16> = chars.encode_utf16().collect();
            units.iter().enumerate().map(|(index, unit)| (index.to_string(), Value::String(String::from_utf16_lossy(&[*unit])))).collect()
        }
        _ => Map::new(),
    }
}

/// `actorId(actor)`: `String(actor?.id ?? actor?.actor_id ?? '')`.
fn actor_id(actor: &Value) -> String {
    s(nullish(prop(Some(actor), "id"), prop(Some(actor), "actor_id")))
}

/// `actorName(state, id)`.
fn actor_name(state: &Value, id: &str) -> String {
    let state = Some(state);
    let actor = list(prop(state, "players"))
        .iter()
        .chain(list(prop(state, "enemies")))
        .chain(list(prop(state, "actors")))
        .find(|candidate| actor_id(candidate) == id);
    match nullish(prop(actor, "character"), prop(actor, "name")) {
        Some(value) => s(Some(value)),
        None => (if id.is_empty() { "участник" } else { id }).to_string(),
    }
}

fn event_type(event: &Value) -> String {
    s(prop(Some(event), "event_type"))
}

/// `String(event.target_ids?.[0] ?? event.payload?.target_id ?? '')`.
fn first_target(event: &Value) -> String {
    let first = index0(prop(Some(event), "target_ids")).filter(|value| !value.is_null());
    match first {
        Some(value) => s(Some(&value)),
        None => s(prop(prop(Some(event), "payload"), "target_id")),
    }
}

fn trigger(kind: &str, actor: String, target: String, name: String) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("kind".into(), string(kind));
    map.insert("actor_id".into(), string(actor));
    map.insert("target_id".into(), string(target));
    map.insert("target_name".into(), string(name));
    map
}

/// `criticalMomentFor(events, state)`: гибель героя, падение врага или героя,
/// бегство и сдача, критический удар героя или по герою — первое найденное по
/// этому порядку.
pub fn critical_moment_for(events: &[Value], state: &Value) -> Option<Value> {
    let enemy_ids: IndexSet<String> = list(prop(Some(state), "enemies")).iter().map(actor_id).collect();
    let player_ids: IndexSet<String> = list(prop(Some(state), "players")).iter().map(actor_id).collect();
    let actor_of = |event: &Value| s(prop(Some(event), "actor_id"));
    for event in events {
        if event_type(event) != "HeroDied" {
            continue;
        }
        let target = first_target(event);
        if player_ids.contains(&target) {
            let name = actor_name(state, &target);
            return Some(Value::Object(trigger("hero_died", actor_of(event), target, name)));
        }
    }
    for event in events {
        if event_type(event) != "HitPointsReducedToZero" {
            continue;
        }
        let target = first_target(event);
        if enemy_ids.contains(&target) {
            let name = actor_name(state, &target);
            return Some(Value::Object(trigger("enemy_defeated", actor_of(event), target, name)));
        }
        if player_ids.contains(&target) {
            let name = actor_name(state, &target);
            return Some(Value::Object(trigger("hero_fallen", actor_of(event), target, name)));
        }
    }
    for event in events {
        if event_type(event) != "ConditionAdded" {
            continue;
        }
        let kind = match s(prop(prop(Some(event), "payload"), "condition")).as_str() {
            "fled" => "enemy_fled",
            "surrendered" => "enemy_surrendered",
            _ => continue,
        };
        let first = index0(prop(Some(event), "target_ids")).filter(|value| !value.is_null());
        let target = match first {
            Some(value) => s(Some(&value)),
            None => actor_of(event),
        };
        let name = actor_name(state, &target);
        return Some(Value::Object(trigger(kind, actor_of(event), target, name)));
    }
    // Критический удар героя или по герою — момент, который описывают словами.
    for event in events {
        let payload = prop(Some(event), "payload");
        if event_type(event) != "AttackResolved" || !js::is_true(prop(payload, "critical")) || js::is_false(prop(payload, "hit")) {
            continue;
        }
        let attacker = actor_of(event);
        let target = match nullish(prop(payload, "target_id"), None) {
            Some(value) => s(Some(value)),
            None => index0(prop(Some(event), "target_ids")).filter(|value| !value.is_null()).map(|value| s(Some(&value))).unwrap_or_default(),
        };
        if !player_ids.contains(&attacker) && !player_ids.contains(&target) {
            continue;
        }
        let name = actor_name(state, &target);
        let attacker_name = actor_name(state, &attacker);
        let mut map = trigger("critical_hit", attacker, target, name);
        map.insert("attacker_name".into(), string(attacker_name));
        return Some(Value::Object(map));
    }
    None
}

/// Реплики ведущего о моменте без живого текста модели.
const CRITICAL_MOMENT_LINES: [(&str, &[&str]); 5] = [
    ("enemy_defeated", &["{name} валится с ног — этот противник своё отвоевал.", "{name} оседает наземь и больше не встаёт в строй.", "Ещё один враг повержен: {name} затихает."]),
    ("hero_fallen", &["{name} оседает на землю без сознания — жизнь ещё теплится.", "{name} падает без чувств; товарищам стоит поспешить.", "{name} рушится на землю и не шевелится — но ещё дышит."]),
    ("hero_died", &["{name} больше не поднимется. Бой идёт дальше — уже без героя."]),
    ("enemy_fled", &["{name} бросает бой и пускается наутёк.", "{name} не выдерживает и бежит."]),
    ("enemy_surrendered", &["{name} бросает оружие и просит пощады.", "{name} опускает оружие: с него хватит."]),
];

/// `template.replace('{name}', name)`: первое вхождение, шаблоны замены JS
/// (`$$`, `$&`, `` $` ``, `$'`) — как у `String.prototype.replace`.
fn replace_name(template: &str, name: &str) -> String {
    let pattern = "{name}";
    let Some(at) = template.find(pattern) else { return template.to_string() };
    let before = &template[..at];
    let after = &template[at + pattern.len()..];
    let mut replacement = String::new();
    let mut chars = name.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '$' {
            replacement.push(ch);
            continue;
        }
        match chars.peek() {
            Some('$') => {
                chars.next();
                replacement.push('$');
            }
            Some('&') => {
                chars.next();
                replacement.push_str(pattern);
            }
            Some('`') => {
                chars.next();
                replacement.push_str(before);
            }
            Some('\'') => {
                chars.next();
                replacement.push_str(after);
            }
            _ => replacement.push('$'),
        }
    }
    format!("{before}{replacement}{after}")
}

/// `criticalMomentLine(trigger, events)`: вариант — по хешу момента и
/// событий, повтор и replay дают ту же строку.
pub fn critical_moment_line(trigger: &Value, events: &[Value]) -> String {
    let kind = s(prop(Some(trigger), "kind"));
    let Some((_, lines)) = CRITICAL_MOMENT_LINES.iter().find(|(id, _)| *id == kind) else { return String::new() };
    let name = text::trim(&s(prop(Some(trigger), "target_name"))).to_string();
    if name.is_empty() {
        return String::new();
    }
    let ids: Vec<String> = events.iter().map(|event| s(prop(Some(event), "event_id"))).collect();
    let seed = format!("{}\u{0}{}\u{0}{}", js::string(prop(Some(trigger), "kind")), js::string(prop(Some(trigger), "target_id")), ids.join("|"));
    let digest = hash::sha256_hex(seed.as_bytes());
    let number = u64::from_str_radix(&digest[..8], 16).unwrap_or(0);
    let index = (number % lines.len() as u64) as usize;
    replace_name(lines[index], &name)
}

/// Поступки героя, к которым игрок может приложить слова.
const HERO_DEED_EVENTS: [&str; 7] = ["AttackResolved", "SpellCast", "SpellSavingThrowResolved", "DamageApplied", "CombatActionUsed", "ShoveResolved", "GrappleResolved"];

/// `heroFlourishFor(events, state, { playerNote, actorId })`: слова игрока к
/// своему ходу в бою — повод для одной-двух фраз ведущего.
pub fn hero_flourish_for(events: &[Value], state: &Value, player_note: Option<&Value>, actor: Option<&Value>) -> Option<Value> {
    let note = text::trim(&s(player_note)).to_string();
    let hero = s(actor);
    if note.is_empty() || hero.is_empty() || !js::truthy(prop(prop(prop(Some(state), "mechanics"), "combat"), "active")) {
        return None;
    }
    if !events.iter().any(|event| s(prop(Some(event), "actor_id")) == hero && HERO_DEED_EVENTS.contains(&event_type(event).as_str())) {
        return None;
    }
    let name = actor_name(state, &hero);
    let mut map = trigger("hero_flourish", hero.clone(), hero, name);
    map.insert("note".into(), string(text::head(&note, 400)));
    Some(Value::Object(map))
}

/// События самого момента падения героя.
const HERO_MOMENT_EVENTS: [&str; 8] = ["AttackResolved", "SpellCast", "SpellSavingThrowResolved", "DamageApplied", "HitPointsReducedToZero", "DeathSavingThrowResolved", "HeroDied", "ConditionAdded"];

fn hero_moment_events(events: &[Value], trigger: &Value) -> Vec<Value> {
    let hero = s(prop(Some(trigger), "target_id"));
    events
        .iter()
        .filter(|event| {
            HERO_MOMENT_EVENTS.contains(&event_type(event).as_str())
                && (s(prop(Some(event), "actor_id")) == hero || list(prop(Some(event), "target_ids")).iter().any(|id| js::string(Some(id)) == hero))
        })
        .cloned()
        .collect()
}

/// `fallenHeroesFor(state)`: погибшие и лежащие без сознания герои с карточкой.
fn fallen_heroes_for(state: &Value) -> Vec<Value> {
    let empty = Value::Object(Map::new());
    let death = nullish(prop(prop(prop(Some(state), "mechanics"), "death"), "heroes"), None).unwrap_or(&empty);
    let dead = |id: &str| s(prop(prop(Some(death), id), "status")) == "dead";
    list(prop(Some(state), "players"))
        .iter()
        .map(|actor| (actor, actor_id(actor)))
        .filter(|(actor, id)| dead(id) || js::number(prop(Some(actor), "hp")) <= 0.0)
        .take(4)
        .map(|(_, id)| {
            let mut card = spread(hero_card_for_agent(state, Some(&string(id.clone()))).as_ref());
            card.insert("condition".into(), string(if dead(&id) { "погиб" } else { "без сознания" }));
            Value::Object(card)
        })
        .collect()
}

/// `publicEnvironment(state, trigger)`.
fn public_environment(state: &Value, trigger: &Value) -> Map<String, Value> {
    let empty = Value::Object(Map::new());
    let scene = nullish(prop(Some(state), "scene"), None).unwrap_or(&empty);
    let kind = s(prop(Some(trigger), "kind"));
    let fallen_card = if kind == "hero_fallen" || kind == "hero_died" { hero_card_for_agent(state, prop(Some(trigger), "target_id")) } else { None };
    let fallen_heroes = if kind == "encounter_aftermath" { fallen_heroes_for(state) } else { Vec::new() };
    let field = field_summary_for(state, None);
    let mut environment = Map::new();
    if let Some(field) = field.filter(|field| js::truthy(Some(field))) {
        environment.insert("field".into(), field);
    }
    if let Some(card) = fallen_card {
        environment.insert("fallen_hero".into(), card);
    }
    if !fallen_heroes.is_empty() {
        environment.insert("fallen_heroes".into(), Value::Array(fallen_heroes));
    }
    environment.insert("campaign_premise".into(), campaign_concept_for_agent(state, None));
    let scene_text = |key: &str| string(s(prop(Some(scene), key)));
    environment.insert(
        "scene".into(),
        json!({ "title": scene_text("title"), "location": scene_text("location"), "mood": scene_text("mood"), "objective": scene_text("objective") }),
    );
    environment.insert("critical_moment".into(), trigger.clone());
    let participants = |key: &str| -> Vec<Value> {
        list(prop(Some(state), key))
            .iter()
            .map(|actor| {
                let id = actor_id(actor);
                json!({ "id": id, "name": actor_name(state, &id) })
            })
            .collect()
    };
    environment.insert("participants".into(), json!({ "heroes": participants("players"), "enemies": participants("enemies") }));
    environment
}

/// `(Array.isArray(recent) ? recent : []).map(String).filter(Boolean)`.
fn recent_list(value: Option<&Value>) -> Vec<Value> {
    list(value).iter().map(|text| s(Some(text))).filter(|text| !text.is_empty()).map(Value::String).collect()
}

/// Аргумент метода: поле объекта или значение по умолчанию.
fn arg<'a>(input: &'a Value, key: &str) -> Option<&'a Value> {
    prop(Some(input), key)
}

fn events_arg(input: &Value) -> Vec<Value> {
    list(arg(input, "events")).to_vec()
}

fn object_or_empty(value: Option<&Value>) -> Value {
    match value {
        None => Value::Object(Map::new()),
        Some(value) => value.clone(),
    }
}

/// `/^deterministic/u.test(String(narration?.provider ?? ''))`.
fn is_deterministic(narration: &Value) -> bool {
    text::test(re!(r"^deterministic", "u"), &s(prop(Some(narration), "provider")))
}

/// `!String(narration?.narration ?? '').trim()`.
fn is_blank(narration: &Value) -> bool {
    text::trim(&s(prop(Some(narration), "narration"))).is_empty()
}

const AFTERMATH_DEFEAT_STYLE: &str = "Три-четыре фразы о том, как отряд приходит в себя после поражения — по событиям: противники ушли, не добив (кто отступил — из событий), герои очнулись сами, прошло долгое время — покажи его светом и небом (к рассвету, к полудню), а не часами. Раны и слабость — словами, без чисел и очков здоровья. Не выдумывай спасителя, пленения и пропаж, которых нет в событиях. Закончи тем, что осталось у отряда и куда тянет цель сцены. За героев не говори и не решай.";
const AFTERMATH_VICTORY_STYLE: &str = "Две-три фразы после схватки: тишина, дыхание, что видно вокруг, и куда тянет цель сцены. Если в fallen_heroes кто-то пал — начни с него: где он лежит и как замирает отряд (погибшего не воскрешай; за живых героев не говори и не решай; без сознания — жив). Добычу, монеты и награды не пересказывай — их показывает стол. Без чисел; не добавляй находок, бросков и решений правил.";
const OPENING_STYLE: &str = "Два-три предложения о начале схватки: кто выходит из укрытия и откуда, как выглядят и что делали здесь до появления героев — по сцене и составу из encounter_foes; имена без номеров («двое разбойников и волк»). Если есть just_happened — то, что герой сделал только что (удар в дверь, стук, слежка), — покажи появление врагов ответом на это: шум услышали, дверь распахнули изнутри, наблюдателя заметили; заявку дословно не пересказывай. Не пересказывай цель сцены, задания и зацепки. Без чисел, ходов, очереди и правил; не добавляй бросков, урона, находок и решений правил.";
const HERO_FALLEN_STYLE: &str = "Три-четыре фразы о падении героя без сознания: удар, как он падает, что видно вокруг, — и ясно, что жизнь ещё теплится. Закончи зовом к тому, кто из героев (participants.heroes) может успеть, по имени: «Борин, она в трёх шагах — успеешь?». Герой ещё не объявлен мёртвым: не описывай смерть, предсмертные слова, похороны или окончательный исход. За живых героев не решай. Не пиши о ходах, очереди и правилах. Не добавляй новых бросков, урона, наград или решений правил.";
const HERO_DIED_STYLE: &str = "Один выразительный абзац об окончательной смерти героя — главный момент вечера. Покажи последний миг: взгляд, движение, то, что осталось несказанным, по fallen_hero (его узы и предыстория — то, ради чего он пришёл), и как замирает поле боя. Не пиши о ходах, очереди и правилах, не говори за живых героев. Не воскрешай героя и не продолжай историю за него. Не добавляй новых бросков, урона, наград или решений правил.";
const HERO_FLOURISH_STYLE: &str = "Две-три фразы о поступке героя — сцена, а не строка журнала. Заявка игрока уже в летописи: не пересказывай её, а покажи, как это выглядело — движение, звук, лицо врага, — как ответил противник и что изменилось на поле по field (кто где, кто ранен, кто рядом). Боевой клич можно коротко подхватить цитатой. Исход — попадание, промах, урон — только из событий, словами, без чисел; не добавляй бросков, урона, наград и решений правил.";
const CRITICAL_HIT_STYLE: &str = "Две фразы о сокрушительном ударе: куда он пришёлся и как его принял тот, по кому ударили, — по событиям и field. Без чисел, бросков и слова «критический»; не добавляй урона, наград и решений правил. Если удар пришёлся по герою — он жив, пока события не сказали иного.";
const ENEMY_DEFEATED_STYLE: &str = "Две-три фразы: как падает противник и чей удар его свалил — по событиям; что это меняет на поле по field (кто ещё стоит, кто рядом). Если есть заявка игрока — вплети её, не пересказывая. Без чисел, ходов и правил; не добавляй бросков, урона, наград и решений правил.";
const DEFAULT_STYLE: &str = "Один выразительный абзац о переломном моменте. Не добавляй новых бросков, урона, наград или решений правил.";

/// `CriticalNarrationCoordinator`.
#[derive(Clone)]
pub struct CriticalNarrationCoordinator {
    narrator: Arc<dyn CriticalNarrator>,
}

impl CriticalNarrationCoordinator {
    /// `new CriticalNarrationCoordinator({ narrator })`.
    pub fn new(narrator: Arc<dyn CriticalNarrator>) -> Self {
        Self { narrator }
    }

    async fn render(&self, brief_input: Value, known_rule_ids: Vec<Value>, recent: Vec<Value>, style: &str) -> Result<Value, CriticalNarrationError> {
        let brief = build_narration_brief(Some(&brief_input)).map_err(CriticalNarrationError::Security)?;
        let options = json!({
            "knownRuleIds": known_rule_ids,
            "timeoutMs": CRITICAL_NARRATION_TIMEOUT_MS,
            "recentNarrations": recent,
            "style": style,
        });
        self.narrator.render(&brief, &options).await.map_err(CriticalNarrationError::Render)
    }

    /// `renderAftermath({ events, state, viewer, recentNarrations })`: сцена
    /// после победы, бегства или поражения отряда; без живого текста — `None`.
    pub async fn render_aftermath(&self, input: &Value) -> Outcome {
        let events = events_arg(input);
        let state = object_or_empty(arg(input, "state"));
        let viewer = object_or_empty(arg(input, "viewer"));
        let outcome = events
            .iter()
            .find(|event| event_type(event) == "EncounterOutcomeRecorded" && event.is_object())
            .and_then(|event| prop(prop(Some(event), "payload"), "outcome"))
            .map(|value| s(Some(value)))
            .unwrap_or_default();
        let defeat = outcome == "party_incapacitated";
        if !defeat && outcome != "enemies_defeated" && outcome != "fled" {
            return Ok(None);
        }
        let trigger = Value::Object(trigger(if defeat { "defeat_aftermath" } else { "encounter_aftermath" }, String::new(), String::new(), String::new()));
        let kinds: &[&str] = if defeat {
            &["EncounterOutcomeRecorded", "ConditionAdded", "HealingApplied", "HeroStabilized", "DowntimeResolved", "TimeAdvanced", "WorldFactRecorded"]
        } else {
            &["EncounterOutcomeRecorded", "EncounterRewardsDistributed", "LootContainerCreated", "WorldFactRecorded"]
        };
        let visible: Vec<Value> = events
            .iter()
            .filter(|event| kinds.contains(&event_type(event).as_str()))
            .filter(|event| {
                event_type(event) != "ConditionAdded" || matches!(s(prop(prop(Some(event), "payload"), "condition")).as_str(), "fled" | "surrendered")
            })
            .map(|event| {
                if event_type(event) != "EncounterOutcomeRecorded" {
                    return event.clone();
                }
                let mut copy = spread(Some(event));
                let mut payload = Map::new();
                if let Some(outcome) = prop(prop(Some(event), "payload"), "outcome") {
                    payload.insert("outcome".into(), outcome.clone());
                }
                copy.insert("payload".into(), Value::Object(payload));
                Value::Object(copy)
            })
            .collect();
        let brief = json!({
            "visible_events": visible,
            "visible_state_changes": [],
            "known_environment": Value::Object(public_environment(&state, &trigger)),
            "permitted_npc_reactions": [],
            "viewer": viewer,
        });
        let style = if defeat { AFTERMATH_DEFEAT_STYLE } else { AFTERMATH_VICTORY_STYLE };
        let narration = self.render(brief, Vec::new(), recent_list(arg(input, "recentNarrations")), style).await?;
        if is_deterministic(&narration) || is_blank(&narration) {
            return Ok(None);
        }
        let mut result = spread(Some(&narration));
        result.insert("trigger".into(), trigger);
        Ok(Some(Value::Object(result)))
    }

    /// `renderEncounterOpening({ events, state, viewer, recentNarrations,
    /// lastPlayerAction })`: абзац ведущего о начале схватки; без живого
    /// текста — `None`.
    pub async fn render_encounter_opening(&self, input: &Value) -> Outcome {
        let events = events_arg(input);
        let state = object_or_empty(arg(input, "state"));
        let viewer = object_or_empty(arg(input, "viewer"));
        let Some(created) = events.iter().find(|event| event_type(event) == "EncounterCreated" && event.is_object()) else { return Ok(None) };
        let encounter = prop(prop(Some(created), "payload"), "encounter");
        if !js::truthy(encounter) {
            return Ok(None);
        }
        let trigger = Value::Object(trigger("encounter_opening", String::new(), String::new(), String::new()));
        let enemies: Vec<String> = list(prop(encounter, "enemies"))
            .iter()
            .map(|enemy| text::trim(&text::replace_all(re!(r"\s+\d+$", "u"), &s(prop(Some(enemy), "name")), "")).to_string())
            .filter(|name| !name.is_empty())
            .take(12)
            .collect();
        let mut event = spread(Some(created));
        event.insert(
            "payload".into(),
            json!({ "encounter": { "theme": s(prop(encounter, "theme")), "enemies": enemies.iter().map(|name| json!({ "name": name })).collect::<Vec<_>>() } }),
        );
        let mut environment = public_environment(&state, &trigger);
        environment.insert("encounter_foes".into(), json!(enemies));
        let action = text::trim(&s(arg(input, "lastPlayerAction"))).to_string();
        if !action.is_empty() {
            environment.insert("just_happened".into(), string(text::head(&action, 400)));
        }
        let brief = json!({
            "visible_events": [Value::Object(event)],
            "visible_state_changes": [],
            "known_environment": Value::Object(environment),
            "permitted_npc_reactions": [],
            "viewer": viewer,
        });
        let narration = self.render(brief, Vec::new(), recent_list(arg(input, "recentNarrations")), OPENING_STYLE).await?;
        if is_deterministic(&narration) || is_blank(&narration) {
            return Ok(None);
        }
        let mut result = spread(Some(&narration));
        result.insert("trigger".into(), trigger);
        Ok(Some(Value::Object(result)))
    }

    /// `renderCriticalMoment({ events, state, viewer, recentNarrations,
    /// playerNote, actorId })`: рассказ критического момента; без живого
    /// текста — детерминированная реплика (у слов героя и критического удара
    /// — пустая).
    pub async fn render_critical_moment(&self, input: &Value) -> Outcome {
        let all_events = events_arg(input);
        let state = object_or_empty(arg(input, "state"));
        let viewer = object_or_empty(arg(input, "viewer"));
        let player_note = arg(input, "playerNote");
        let actor = arg(input, "actorId");
        let moment = critical_moment_for(&all_events, &state);
        let note = text::trim(&s(player_note)).to_string();
        let trigger = match moment {
            Some(moment) => {
                if !note.is_empty() && js::truthy(actor) && js::string(prop(Some(&moment), "actor_id")) == js::string(actor) {
                    let mut copy = spread(Some(&moment));
                    copy.insert("note".into(), string(text::head(&note, 400)));
                    Value::Object(copy)
                } else {
                    moment
                }
            }
            None => match hero_flourish_for(&all_events, &state, player_note, actor) {
                Some(flourish) => flourish,
                None => return Ok(None),
            },
        };
        let kind = s(prop(Some(&trigger), "kind"));
        let hero_moment = kind == "hero_fallen" || kind == "hero_died";
        let focused = if hero_moment { hero_moment_events(&all_events, &trigger) } else { Vec::new() };
        let events = if focused.is_empty() { all_events.clone() } else { focused };
        let state_changes: Vec<Value> = events
            .iter()
            .map(|event| {
                let field = |key: &str| prop(Some(event), key);
                let mut change = Map::new();
                if let Some(kind) = field("event_type") {
                    change.insert("event_type".into(), kind.clone());
                }
                change.insert("actor_id".into(), nullish(field("actor_id"), None).cloned().unwrap_or(Value::Null));
                change.insert("target_ids".into(), nullish(field("target_ids"), None).cloned().unwrap_or_else(|| json!([])));
                change.insert("payload".into(), nullish(field("payload"), None).cloned().unwrap_or_else(|| json!({})));
                change.insert("source_rule_ids".into(), nullish(field("source_rule_ids"), None).cloned().unwrap_or_else(|| json!([])));
                change.insert("visibility".into(), nullish(field("visibility"), None).cloned().unwrap_or_else(|| json!("public")));
                Value::Object(change)
            })
            .collect();
        let mut environment = public_environment(&state, &trigger);
        if let Some(note) = prop(Some(&trigger), "note").filter(|note| js::truthy(Some(note))) {
            environment.insert("player_intent".into(), json!({ "action": note }));
        }
        let reactions = if kind == "enemy_fled" || kind == "enemy_surrendered" {
            json!([{ "actor_id": prop(Some(&trigger), "target_id").cloned().unwrap_or(Value::Null), "reaction": kind }])
        } else {
            json!([])
        };
        let mut known_rule_ids: Vec<Value> = Vec::new();
        for event in &events {
            match nullish(prop(Some(event), "source_rule_ids"), None) {
                None => {}
                Some(Value::Array(ids)) => {
                    for id in ids {
                        if !known_rule_ids.contains(id) {
                            known_rule_ids.push(id.clone());
                        }
                    }
                }
                Some(other) => {
                    if !known_rule_ids.contains(other) {
                        known_rule_ids.push(other.clone());
                    }
                }
            }
        }
        let brief = json!({
            "visible_events": events,
            "visible_state_changes": state_changes,
            "known_environment": Value::Object(environment),
            "permitted_npc_reactions": reactions,
            "viewer": viewer,
        });
        let style = match kind.as_str() {
            "hero_fallen" => HERO_FALLEN_STYLE,
            "hero_died" => HERO_DIED_STYLE,
            "hero_flourish" => HERO_FLOURISH_STYLE,
            "critical_hit" => CRITICAL_HIT_STYLE,
            "enemy_defeated" => ENEMY_DEFEATED_STYLE,
            _ => DEFAULT_STYLE,
        };
        let narration = self.render(brief, known_rule_ids, recent_list(arg(input, "recentNarrations")), style).await?;
        let deterministic = is_deterministic(&narration);
        let mut result = spread(Some(&narration));
        if deterministic && (kind == "hero_flourish" || kind == "critical_hit") {
            result.insert("narration".into(), string(""));
            result.insert("trigger".into(), trigger);
            return Ok(Some(Value::Object(result)));
        }
        let fallback = if deterministic { critical_moment_line(&trigger, &all_events) } else { String::new() };
        if !fallback.is_empty() {
            result.insert("narration".into(), string(fallback));
        }
        result.insert("trigger".into(), trigger);
        Ok(Some(Value::Object(result)))
    }
}

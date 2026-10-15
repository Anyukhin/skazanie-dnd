//! Перенос `server/captives.mjs`: пленные — «мы его не убили, а допросим».
//!
//! Захват выводится из конца боя (`EndCombat`): сдавшийся или нокаутнутый враг
//! подходящего вида становится NPC со своим профилем, собранным детерминиро-
//! ванно от сида кампании и id актора. Пленный — состояние поверх существующего
//! актора; то, что он знает, лежит в памяти мира под `gm_only` и раскрывается
//! допросом. Сутки без еды дают `CaptiveNeglected` — поступок жестокости.
//!
//! Данные на границе — `serde_json::Value` той же формы, что в JS: реестр
//! `{ schema_version, captives }`, черновики событий
//! `{ event_type, payload, target_ids, visibility }`.

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{js, re, text as jstext};
use sk_npc_world::npc_positioning::{is_valid_npc_post, npc_placement_for, present_scene_npcs, scene_location_id};
use sk_social::npc_social::campaign_elapsed_minutes;
use sk_society::reputation_policy::faction_ids_for_npc;

use crate::common::{
    array, coalesce, comparable, digest, digest_u32, f64_value, get, integer, is_safe_id, is_str, iterate, js_length, js_max, js_min, js_plus_one, member, replace_all_literal,
    safe_integer, same_value_zero, spread, string, text, text_str, utf16_cmp, Member,
};

pub const CAPTIVES_SCHEMA_VERSION: i64 = 1;
pub const CAPTIVES_POLICY_ID: &str = "skazanie:captives-v1";

/// Кого вообще можно взять в плен: связать, довести и разговорить.
pub const CAPTURABLE_CREATURE_TYPES: [&str; 5] = ["humanoid", "giant", "fiend", "celestial", "dragon"];

pub const CAPTIVE_STATUSES: [&str; 4] = ["held", "released", "handed_over", "dead"];
pub const CAPTIVE_ORIGINS: [&str; 2] = ["surrendered", "knocked_out"];

/// Действия с пленным. `NeglectCaptive` в наборе игрока нет намеренно: голод
/// фиксируют мировые часы, а не кнопка.
pub const CAPTIVE_PLAYER_COMMAND_TYPES: [&str; 5] = ["InterrogateCaptive", "ReleaseCaptive", "HandCaptiveToGuards", "FeedCaptive", "ExecuteCaptive"];
pub const CAPTIVE_COMMAND_TYPES: [&str; 6] = ["InterrogateCaptive", "ReleaseCaptive", "HandCaptiveToGuards", "FeedCaptive", "ExecuteCaptive", "NeglectCaptive"];

/// Сутки игрового времени без еды — и связанный начинает страдать.
pub const CAPTIVE_FEED_INTERVAL_MINUTES: i64 = 1_440;

/// Виды поселений, где есть кому принять пленного. Дословно совпадает с
/// `SETTLEMENT_LOCATION_KINDS` закона (`law-and-order`).
pub const SETTLEMENT_LOCATION_KINDS: [&str; 6] = ["town", "village", "city", "capital", "port", "fortress"];

const MAX_CAPTIVES: usize = 60;
const MAX_KNOWN_FACTS: usize = 2;

/// Характер пленного: решает и текст, и сложность допроса.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptiveTemper {
    pub id: &'static str,
    pub label: &'static str,
    pub dc_shift: i64,
    pub voice: &'static str,
}

pub const CAPTIVE_TEMPERS: [CaptiveTemper; 5] = [
    CaptiveTemper { id: "broken", label: "сломлен и покорен", dc_shift: -2, voice: "говорит тихо, не поднимая глаз" },
    CaptiveTemper { id: "talkative", label: "болтлив от страха", dc_shift: -1, voice: "тараторит и повторяется" },
    CaptiveTemper { id: "sullen", label: "угрюм и неразговорчив", dc_shift: 0, voice: "отвечает односложно" },
    CaptiveTemper { id: "haggler", label: "хитёр и торгуется", dc_shift: 1, voice: "на каждый ответ просит своё" },
    CaptiveTemper { id: "defiant", label: "дерзок даже связанным", dc_shift: 2, voice: "цедит сквозь зубы" },
];

const CAPTIVE_EPITHETS: [&str; 12] = ["Кривой", "Меченый", "Рябой", "Тихий", "Косматый", "Одноухий", "Хромой", "Беспалый", "Задира", "Битый", "Скорый", "Сивый"];
const CAPTIVE_NAMES: [&str; 12] = ["Ждан", "Бажен", "Горыня", "Малюта", "Некрас", "Путята", "Хват", "Ярец", "Гудим", "Молчан", "Сувор", "Томило"];

pub const CAPTIVE_INTERROGATION_SKILLS: [&str; 2] = ["persuasion", "intimidation"];
const INTERROGATION_ABILITY: &str = "cha";

/// Базовая СЛ разговора со связанным, сдвиг страха и шаг за каждый вытянутый факт.
pub const CAPTIVE_BASE_DC: i64 = 15;
pub const CAPTIVE_FEAR_DC_SHIFT: i64 = -3;
pub const CAPTIVE_REPEAT_DC_STEP: i64 = 3;

/// Насколько пощада двигает личное отношение.
pub const CAPTIVE_SPARED_RELATIONSHIP_DELTA: i64 = 12;

const DISPOSITIONS: [&str; 3] = ["ally", "informant", "none"];

struct LeadTemplate {
    predicate: &'static str,
    summary: &'static str,
}

const CAPTIVE_LEAD_TEMPLATES: [LeadTemplate; 4] = [
    LeadTemplate { predicate: "band_camp", summary: "Лагерь ватаги стоит {direction} от «{place}» — меньше половины дневного перехода." },
    LeadTemplate { predicate: "band_paid", summary: "Ватага пришла в «{place}» не сама: за налёт заплатили вперёд, и заказчик ждёт вестей." },
    LeadTemplate { predicate: "band_reinforcements", summary: "В «{place}» ватага ждала подкрепление — оно выйдет со дня на день." },
    LeadTemplate { predicate: "band_cache", summary: "У ватаги есть схрон: туда снесли всё взятое в «{place}» и окрестностях." },
];

const LEAD_DIRECTIONS: [&str; 6] = ["к северу", "к югу", "к востоку", "к западу", "выше по дороге", "за ближайшим гребнем"];

/// Индекс детерминированного выбора `pick(list, seed, salt)`.
fn pick_index(len: usize, seed: &str, salt: &str) -> usize {
    (digest_u32(&[seed.to_string(), salt.to_string()]) % len as u64) as usize
}

/// `Math.max(minimum, Math.min(maximum, value))`.
fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    js_max(minimum, js_min(maximum, value))
}

fn insert_raw(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.to_string(), value.clone());
    }
}

// ---------------------------------------------------------------------------
// Детерминированный профиль безымянного врага
// ---------------------------------------------------------------------------

/// Семья стат-блока (`captiveBandId`): «goblin-warrior» и «goblin-minion» — одна ватага.
pub fn captive_band_id(stat_block_id: Option<&Value>, name: Option<&Value>) -> String {
    let full = text(stat_block_id, 120);
    let slug = full.split(':').next_back().unwrap_or("").to_string();
    let family = jstext::replace_first(re!(r"-(?:minion|warrior|captain|veteran|boss|scout|spy|guard)$", "u"), &slug, "");
    if !family.is_empty() {
        return text_str(&family, 60);
    }
    let from_name = jstext::replace_first(re!(r"\s+\d+$", "u"), &comparable(name), "");
    if !from_name.is_empty() {
        return text_str(&from_name, 60);
    }
    "unknown".into()
}

fn captive_seed(state: &Value, actor_id: Option<&Value>) -> String {
    digest(&[text(get(Some(state), "sessionCode"), 60), text(actor_id, 120)])
}

fn creature_type_of(enemy: &Value) -> String {
    let enemy = Some(enemy);
    comparable(coalesce(coalesce(coalesce(get(enemy, "creature_type"), get(enemy, "creatureType")), get(enemy, "monster_type")), get(enemy, "kind")))
}

/// Имя и характер безымянного врага (`captivePersona`). Одинаковы после
/// каждого replay; прозвище из таблицы получают только люди.
pub fn captive_persona(state: &Value, enemy: &Value) -> Value {
    let seed = captive_seed(state, get(Some(enemy), "id"));
    let temper = CAPTIVE_TEMPERS[pick_index(CAPTIVE_TEMPERS.len(), &seed, "temper")];
    let own = text(get(Some(enemy), "name"), 120);
    let stripped = jstext::replace_first(re!(r"\s+\d+$", "u"), &own, "");
    let role = if stripped.is_empty() { "Пленник".to_string() } else { stripped };
    let nickname = format!(
        "{} {}",
        CAPTIVE_EPITHETS[pick_index(CAPTIVE_EPITHETS.len(), &seed, "epithet")],
        CAPTIVE_NAMES[pick_index(CAPTIVE_NAMES.len(), &seed, "name")]
    );
    let name = if creature_type_of(enemy) == "humanoid" || own.is_empty() { nickname } else { own };
    json!({
        "seed": seed,
        "name": name,
        "role": role,
        "temper": temper.id,
        "temper_label": temper.label,
        "voice": temper.voice,
    })
}

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

fn fact_id_list(value: Option<&Value>) -> Vec<Value> {
    let mut seen: IndexSet<String> = IndexSet::new();
    for entry in array(value) {
        let id = text(Some(entry), 120);
        if !id.is_empty() {
            seen.insert(id);
        }
    }
    seen.into_iter().take(MAX_KNOWN_FACTS).map(Value::String).collect()
}

fn optional_minutes(value: Option<&Value>) -> Value {
    if js::present(value) {
        json!(integer(value, 0).max(0))
    } else {
        Value::Null
    }
}

/// `safeCaptive`: запись пленного или `None`, если она не проходит.
fn safe_captive(value: Option<&Value>) -> Option<Map<String, Value>> {
    // `safeCaptive(undefined)` — пустой объект; не объект — без полей.
    let source = value;
    let id = text(get(source, "id"), 120);
    let npc_id = text(get(source, "npc_id"), 120);
    if !is_safe_id(&id, 119) || npc_id.is_empty() {
        return None;
    }
    let taken_at = integer(get(source, "taken_at_minutes"), 0).max(0);
    let temper = get(source, "temper");
    let temper = match temper {
        Some(Value::String(id)) if CAPTIVE_TEMPERS.iter().any(|entry| entry.id == id) => id.clone(),
        _ => "sullen".into(),
    };
    let origin = match get(source, "origin") {
        Some(Value::String(origin)) if CAPTIVE_ORIGINS.contains(&origin.as_str()) => origin.clone(),
        _ => "surrendered".into(),
    };
    let status = match get(source, "status") {
        Some(Value::String(status)) if CAPTIVE_STATUSES.contains(&status.as_str()) => status.clone(),
        _ => "held".into(),
    };
    let disposition = match get(source, "disposition") {
        Some(Value::String(disposition)) if DISPOSITIONS.contains(&disposition.as_str()) => disposition.clone(),
        _ => "none".into(),
    };
    let mut map = Map::new();
    map.insert("id".into(), string(id));
    map.insert("npc_id".into(), string(npc_id));
    map.insert("actor_id".into(), string(text(get(source, "actor_id"), 120)));
    map.insert("name".into(), string(text(get(source, "name"), 160)));
    map.insert("role".into(), string(text(get(source, "role"), 160)));
    map.insert("temper".into(), string(temper));
    map.insert("origin".into(), string(origin));
    map.insert("status".into(), string(status));
    map.insert("band_id".into(), string(text(get(source, "band_id"), 60)));
    map.insert("stat_block_id".into(), string(text(get(source, "stat_block_id"), 120)));
    map.insert("xp".into(), json!(integer(get(source, "xp"), 0).max(0)));
    map.insert("taken_at_minutes".into(), json!(taken_at));
    map.insert("location_id".into(), string(text(get(source, "location_id"), 180)));
    map.insert("location_name".into(), string(text(get(source, "location_name"), 180)));
    map.insert("known_fact_ids".into(), Value::Array(fact_id_list(get(source, "known_fact_ids"))));
    map.insert("revealed_fact_ids".into(), Value::Array(fact_id_list(get(source, "revealed_fact_ids"))));
    map.insert("interrogations".into(), json!(integer(get(source, "interrogations"), 0).max(0)));
    map.insert("last_fed_at_minutes".into(), json!(integer(get(source, "last_fed_at_minutes"), taken_at).max(0)));
    map.insert("neglected_at_minutes".into(), optional_minutes(get(source, "neglected_at_minutes")));
    map.insert("resolved_at_minutes".into(), optional_minutes(get(source, "resolved_at_minutes")));
    map.insert("resolution".into(), string(text(get(source, "resolution"), 60)));
    map.insert("disposition".into(), string(disposition));
    map.insert("policy_id".into(), string(CAPTIVES_POLICY_ID));
    Some(map)
}

/// Реестр пленных (`normalizeCaptivesState`): без повторов id, не больше
/// шестидесяти последних.
pub fn normalize_captives_state(input: Option<&Value>) -> Value {
    let mut captives: Vec<Value> = Vec::new();
    let mut seen: IndexSet<String> = IndexSet::new();
    for raw in array(get(input, "captives")) {
        // `safeCaptive(null)` в JS бросает `TypeError`; здесь такая запись
        // просто не проходит.
        let Some(captive) = safe_captive(Some(raw)) else { continue };
        let id = js::s(captive.get("id"));
        if !seen.insert(id) {
            continue;
        }
        captives.push(Value::Object(captive));
    }
    let start = captives.len().saturating_sub(MAX_CAPTIVES);
    json!({ "schema_version": CAPTIVES_SCHEMA_VERSION, "captives": captives.split_off(start) })
}

fn captives_of(registry: Value) -> Vec<Value> {
    match registry {
        Value::Object(mut map) => match map.shift_remove("captives") {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// Пленные кампании (`captiveList`).
pub fn captive_list(state: &Value) -> Vec<Value> {
    captives_of(normalize_captives_state(get(Some(state), "captives")))
}

/// Пленный по id (`captiveFor`).
pub fn captive_for(state: &Value, captive_id: Option<&Value>) -> Option<Value> {
    let expected = text(captive_id, 120);
    captive_list(state).into_iter().find(|captive| is_str(captive.get("id"), &expected))
}

/// Пленный, которого прямо сейчас держит отряд, по id его NPC (`heldCaptiveForNpc`).
pub fn held_captive_for_npc(state: &Value, npc_id: Option<&Value>) -> Option<Value> {
    let expected = text(npc_id, 120);
    captive_list(state).into_iter().find(|captive| is_str(captive.get("npc_id"), &expected) && is_str(captive.get("status"), "held"))
}

/// Удерживаемые пленные (`heldCaptives`).
pub fn held_captives(state: &Value) -> Vec<Value> {
    captive_list(state).into_iter().filter(|captive| is_str(captive.get("status"), "held")).collect()
}

/// Id записи плена для актора (`captiveIdFor`).
pub fn captive_id_for(state: &Value, actor_id: Option<&Value>) -> String {
    format!("captive:{}", &captive_seed(state, actor_id)[..24])
}

// ---------------------------------------------------------------------------
// Захват на конце боя
// ---------------------------------------------------------------------------

/// `conditionIds(state, actorId)`: id состояний актора (`String(c?.id ?? c)`).
fn condition_ids(state: &Value, actor_id: Option<&Value>) -> IndexSet<String> {
    let conditions = get(get(Some(state), "mechanics"), "conditions");
    let key = js::string(actor_id);
    // Не массив (в том числе ключ прототипа как id) в JS бросает `TypeError`.
    let list = match member(conditions, &key) {
        Member::Own(value) => array(Some(value)),
        _ => &[],
    };
    list.iter().map(|condition| js::string(coalesce(get(Some(condition), "id"), Some(condition)))).collect()
}

/// Почему этот враг переживает бой пленным (`captiveOriginFor`); `None` — не переживает.
pub fn captive_origin_for(state: &Value, enemy: &Value) -> Option<&'static str> {
    if !CAPTURABLE_CREATURE_TYPES.contains(&creature_type_of(enemy).as_str()) {
        return None;
    }
    let id = get(Some(enemy), "id");
    let conditions = condition_ids(state, id);
    if conditions.contains("surrendered") {
        return Some("surrendered");
    }
    let resting = get(get(Some(state), "mechanics"), "resting");
    let knocked_out = is_str(get(get(resting, &js::string(id)), "reason"), "knockout");
    if knocked_out && conditions.contains("unconscious") {
        return Some("knocked_out");
    }
    None
}

/// Враг, которого конец боя делает пленным.
#[derive(Debug, Clone, PartialEq)]
pub struct CapturableEnemy {
    pub enemy: Value,
    pub origin: &'static str,
}

impl CapturableEnemy {
    pub fn to_json(&self) -> Value {
        json!({ "enemy": self.enemy, "origin": self.origin })
    }
}

/// Кого конец боя берёт в плен (`capturableEnemies`): не сбежавшие и ещё не
/// записанные в реестр (по всему реестру, а не только удерживаемым).
pub fn capturable_enemies(state: &Value) -> Vec<CapturableEnemy> {
    let known: IndexSet<String> = captive_list(state).iter().map(|captive| js::s(captive.get("actor_id"))).collect();
    let mut result: Vec<CapturableEnemy> = array(get(Some(state), "enemies"))
        .iter()
        .filter(|enemy| {
            let id = get(Some(enemy), "id");
            js::truthy(id) && !known.contains(&js::string(id)) && !condition_ids(state, id).contains("fled")
        })
        .filter_map(|enemy| captive_origin_for(state, enemy).map(|origin| CapturableEnemy { enemy: enemy.clone(), origin }))
        .collect();
    result.sort_by(|left, right| jstext::locale_compare(&js::string(left.enemy.get("id")), &js::string(right.enemy.get("id"))));
    result
}

/// Что пленный знает (`captiveKnowledgeDrafts`): уже записанные `gm_only`
/// факты места, а если их нет — детерминированная зацепка по шаблону.
pub fn captive_knowledge_drafts(state: &Value, captive: &Value) -> Value {
    let captive_ref = Some(captive);
    let facts: Vec<&Value> = array(get(get(Some(state), "worldMemory"), "facts"))
        .iter()
        .filter(|fact| is_str(get(Some(fact), "status"), "active") && is_str(get(Some(fact), "visibility"), "gm_only"))
        .collect();
    let location_name = get(captive_ref, "location_name");
    let place_source = if js::truthy(location_name) { location_name } else { get(captive_ref, "location_id") };
    let place_key = comparable(place_source);
    let mut existing: Vec<String> = facts
        .iter()
        .filter(|fact| !place_key.is_empty() && (comparable(get(Some(fact), "summary")).contains(&place_key) || comparable(get(Some(fact), "object")).contains(&place_key)))
        .map(|fact| js::string(get(Some(fact), "id")))
        .collect();
    existing.sort_by(|a, b| utf16_cmp(a, b));
    existing.truncate(MAX_KNOWN_FACTS);
    if !existing.is_empty() {
        return json!({ "fact_ids": existing, "drafts": [] });
    }
    let captive_id = js::s(get(captive_ref, "id"));
    let template = &CAPTIVE_LEAD_TEMPLATES[pick_index(CAPTIVE_LEAD_TEMPLATES.len(), &captive_id, "lead")];
    let direction = LEAD_DIRECTIONS[pick_index(LEAD_DIRECTIONS.len(), &captive_id, "direction")];
    let fact_id = format!("fact:captive-lead:{}", &digest(&[captive_id, template.predicate.to_string()])[..20]);
    let place = if js::truthy(location_name) { js::s(location_name) } else { "этих краях".to_string() };
    let summary = replace_all_literal(&replace_all_literal(template.summary, "{place}", &place), "{direction}", direction);
    let mut fact = Map::new();
    fact.insert("id".into(), string(fact_id.clone()));
    insert_raw(&mut fact, "subject_id", get(captive_ref, "npc_id"));
    fact.insert("predicate".into(), string(template.predicate));
    insert_raw(&mut fact, "object", get(captive_ref, "band_id"));
    fact.insert("summary".into(), string(summary));
    fact.insert("visibility".into(), string("gm_only"));
    fact.insert("source_event_ids".into(), json!([]));
    fact.insert("status".into(), string("active"));
    insert_raw(&mut fact, "recorded_at_minutes", get(captive_ref, "taken_at_minutes"));
    json!({
        "fact_ids": [fact_id],
        "drafts": [{
            "event_type": "WorldFactRecorded",
            "payload": { "fact": Value::Object(fact) },
            "target_ids": [],
            "visibility": "gm_only",
        }],
    })
}

fn captive_post(state: &Value, enemy: &Value) -> Option<Value> {
    let enemy_id = js::string(get(Some(enemy), "id"));
    let positions = get(get(Some(state), "mechanics"), "positions");
    let (x, y) = match member(positions, &enemy_id) {
        Member::Own(Value::Null) | Member::Missing => (get(Some(enemy), "x"), get(Some(enemy), "y")),
        Member::Own(position) => (get(Some(position), "x"), get(Some(position), "y")),
        // Функция или прототип: своих `x`/`y` нет — `NaN`.
        Member::Inherited => (None, None),
    };
    let (x, y) = (safe_integer(x)?, safe_integer(y)?);
    let candidate = json!({ "x": x, "y": y });
    is_valid_npc_post(state, Some(&candidate), None, &enemy_id).then_some(candidate)
}

fn npc_id_strings(state: &Value) -> Vec<(String, &Value)> {
    array(get(get(Some(state), "social"), "npcs"))
        .iter()
        .map(|npc| (js::s(get(Some(npc), "id")), npc))
        .collect()
}

/// События захвата (`planCaptureDrafts`) — черновики
/// `event_type`/`payload`/`target_ids`/`visibility`.
pub fn plan_capture_drafts(state: &Value) -> Vec<Value> {
    let mut drafts = Vec::new();
    let minutes = f64_value(campaign_elapsed_minutes(state));
    let location_id = scene_location_id(state);
    let scene = get(Some(state), "scene");
    let location_name = text(coalesce(get(scene, "location"), get(scene, "title")), 180);
    let npcs = npc_id_strings(state);
    let existing_npc_ids: IndexSet<String> = npcs.iter().map(|(id, _)| id.clone()).collect();
    let parley_stub_npc_ids: IndexSet<String> = npcs
        .iter()
        .filter(|(_, npc)| js::is_false(get(Some(npc), "available")) && array(get(Some(npc), "tags")).iter().any(|tag| is_str(Some(tag), "parley-leader")))
        .map(|(id, _)| id.clone())
        .collect();
    let mut existing_entity_ids: IndexSet<String> = array(get(get(Some(state), "worldMemory"), "entities")).iter().map(|entity| js::s(get(Some(entity), "id"))).collect();
    let place = if location_name.is_empty() { location_id.clone() } else { location_name.clone() };
    for CapturableEnemy { enemy, origin } in capturable_enemies(state) {
        let enemy_ref = Some(&enemy);
        let npc_id = js::s(get(enemy_ref, "id"));
        let persona = captive_persona(state, &enemy);
        let known = npcs.iter().find(|(id, _)| *id == npc_id).map(|(_, npc)| *npc);
        let band_id = captive_band_id(get(enemy_ref, "stat_block_id"), get(enemy_ref, "name"));
        let known_name = text(get(known, "name"), 160);
        let known_role = text(get(known, "role"), 160);
        let draft = json!({
            "id": captive_id_for(state, Some(&string(npc_id.clone()))),
            "npc_id": npc_id,
            "actor_id": npc_id,
            "name": if known_name.is_empty() { persona["name"].clone() } else { string(known_name) },
            "role": if known_role.is_empty() { persona["role"].clone() } else { string(known_role) },
            "temper": persona["temper"],
            "origin": origin,
            "status": "held",
            "band_id": band_id,
            "stat_block_id": text(get(enemy_ref, "stat_block_id"), 120),
            "xp": integer(get(get(enemy_ref, "provenance"), "xp"), 0).max(0),
            "taken_at_minutes": minutes,
            "location_id": location_id,
            "location_name": location_name,
            "last_fed_at_minutes": minutes,
        });
        let Some(captive) = safe_captive(Some(&draft)) else { continue };
        let captive_name = captive.get("name").cloned().unwrap_or(Value::Null);
        let captive_role = captive.get("role").cloned().unwrap_or(Value::Null);
        if !existing_npc_ids.contains(&npc_id) || parley_stub_npc_ids.contains(&npc_id) {
            drafts.push(json!({
                "event_type": "NpcSocialProfileUpserted",
                "payload": {
                    "npc": {
                        "id": npc_id,
                        "name": captive_name,
                        "role": captive_role,
                        "location": place,
                        "public_summary": format!("Пленник отряда: {}.", js::s(persona.get("temper_label"))),
                        "voice": persona["voice"],
                        "goals": ["выбраться живым"],
                        "beliefs": [],
                        "known_fact_ids": [],
                        "social_dcs": {},
                        "visibility": "party",
                        "available": true,
                        "tags": ["captive", format!("faction:band:{band_id}")],
                        "schedule": [],
                        "inventory": [],
                    },
                },
                "target_ids": [],
                "visibility": "party",
            }));
        }
        let post = captive_post(state, &enemy);
        let npc_id_value = string(npc_id.clone());
        let location_id_value = string(location_id.clone());
        if let Some(post) = post {
            if npc_placement_for(state, &npc_id_value, Some(&location_id_value)).is_none() {
                drafts.push(json!({
                    "event_type": "NpcPlaced",
                    "payload": {
                        "npc_id": npc_id,
                        "npc_name": captive_name,
                        "npc_role": captive_role,
                        "location_id": location_id,
                        "x": post["x"],
                        "y": post["y"],
                        "anchor_prop_id": "",
                        "placement_reason": "captive-taken",
                        "vitality": { "hp": 1, "max_hp": integer(get(enemy_ref, "maxHp"), 4).max(1), "alive": true },
                    },
                    "target_ids": [npc_id],
                    "visibility": "party",
                }));
            }
        }
        if !existing_entity_ids.contains(&npc_id) {
            drafts.push(json!({
                "event_type": "WorldEntityUpserted",
                "payload": {
                    "entity": {
                        "id": npc_id,
                        "kind": "npc",
                        "name": captive_name,
                        "summary": format!("{}, взят(а) в плен отрядом.", js::s(Some(&captive_role))),
                        "aliases": [],
                        "visibility": "party",
                        "tags": ["captive"],
                    },
                },
                "target_ids": [],
                "visibility": "party",
            }));
            existing_entity_ids.insert(npc_id.clone());
        }
        let captive_value = Value::Object(captive);
        let mut knowledge = captive_knowledge_drafts(state, &captive_value);
        if let Some(Value::Array(items)) = knowledge.get_mut("drafts").map(Value::take) {
            drafts.extend(items);
        }
        let mut taken = match captive_value {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        taken.insert("known_fact_ids".into(), knowledge.get("fact_ids").cloned().unwrap_or_else(|| json!([])));
        drafts.push(json!({
            "event_type": "CaptiveTaken",
            "payload": { "captive": Value::Object(taken) },
            "target_ids": [npc_id],
            "visibility": "party",
        }));
    }
    drafts
}

/// Пленный идёт с отрядом (`planCaptiveRelocationDrafts`).
pub fn plan_captive_relocation_drafts(state: &Value) -> Vec<Value> {
    let location_id = scene_location_id(state);
    let scene = get(Some(state), "scene");
    let location_name = text(coalesce(get(scene, "location"), get(scene, "title")), 180);
    let place = if location_name.is_empty() { location_id.clone() } else { location_name.clone() };
    let place_key = comparable(Some(&string(place.clone())));
    let npcs = npc_id_strings(state);
    let mut drafts = Vec::new();
    for captive in held_captives(state) {
        let npc_id = js::s(captive.get("npc_id"));
        let Some((_, npc)) = npcs.iter().find(|(id, _)| *id == npc_id) else { continue };
        if comparable(get(Some(npc), "location")) == place_key {
            continue;
        }
        let mut profile = spread(Some(npc));
        profile.insert("location".into(), string(place.clone()));
        // `dossier: undefined` — в JSON поля нет.
        profile.shift_remove("dossier");
        drafts.push(json!({
            "event_type": "NpcSocialProfileUpserted",
            "payload": { "npc": Value::Object(profile) },
            "target_ids": [],
            "visibility": "party",
        }));
        drafts.push(json!({
            "event_type": "CaptiveMoved",
            "payload": {
                "captive_id": captive["id"],
                "npc_id": npc_id,
                "location_id": location_id,
                "location_name": location_name,
                "policy_id": CAPTIVES_POLICY_ID,
            },
            "target_ids": [npc_id],
            "visibility": "party",
        }));
    }
    drafts
}

// ---------------------------------------------------------------------------
// Допрос
// ---------------------------------------------------------------------------

/// `list.includes(value)` у массива (SameValueZero) и строки (подстрока).
fn includes(list: Option<&Value>, value: &Value) -> bool {
    match list {
        Some(Value::Array(items)) => items.iter().any(|item| same_value_zero(item, value)),
        Some(Value::String(text)) => text.contains(&js::string(Some(value))),
        _ => false,
    }
}

/// СЛ и навык допроса (`captiveInterrogationPolicy`). `options` —
/// `{ skill, reputationShift }`, как в JS.
pub fn captive_interrogation_policy(_state: &Value, captive: &Value, options: &Value) -> Value {
    let skill = match get(Some(options), "skill") {
        None => "intimidation",
        Some(Value::String(skill)) if CAPTIVE_INTERROGATION_SKILLS.contains(&skill.as_str()) => {
            if skill == "persuasion" {
                "persuasion"
            } else {
                "intimidation"
            }
        }
        Some(_) => "intimidation",
    };
    let reputation_shift = integer(get(Some(options), "reputationShift"), 0);
    let captive_ref = Some(captive);
    let temper = match get(captive_ref, "temper") {
        Some(Value::String(id)) => CAPTIVE_TEMPERS.iter().find(|entry| entry.id == id).copied().unwrap_or(CAPTIVE_TEMPERS[2]),
        _ => CAPTIVE_TEMPERS[2],
    };
    let skill_shift = if skill == "intimidation" {
        if temper.id == "defiant" {
            1
        } else {
            -1
        }
    } else if temper.id == "haggler" {
        -1
    } else {
        1
    };
    let revealed_source = coalesce(get(captive_ref, "revealed_fact_ids"), None);
    let revealed = revealed_source.map_or(0.0, js_length);
    let difficulty = clamp(
        (CAPTIVE_BASE_DC + CAPTIVE_FEAR_DC_SHIFT + temper.dc_shift + skill_shift) as f64
            + revealed * CAPTIVE_REPEAT_DC_STEP as f64
            + clamp(reputation_shift as f64, -3.0, 3.0),
        5.0,
        25.0,
    );
    let empty = json!([]);
    let revealed_list = revealed_source.unwrap_or(&empty);
    let pending: Vec<&Value> = array(coalesce(get(captive_ref, "known_fact_ids"), None))
        .iter()
        .filter(|fact_id| !includes(Some(revealed_list), fact_id))
        .collect();
    json!({
        "skill": skill,
        "ability": INTERROGATION_ABILITY,
        "difficulty": js::num(difficulty),
        "fear_shift": CAPTIVE_FEAR_DC_SHIFT,
        "temper": temper.id,
        "temper_label": temper.label,
        "fact_id": pending.first().map_or_else(|| string(""), |first| if first.is_null() { string("") } else { (*first).clone() }),
        "exhausted": pending.is_empty(),
    })
}

// ---------------------------------------------------------------------------
// Отпустить, сдать страже, покормить
// ---------------------------------------------------------------------------

/// Кем вернётся пощажённый (`captiveSparedDisposition`): решено при захвате.
pub fn captive_spared_disposition(captive: &Value) -> &'static str {
    const LIST: [&str; 4] = ["informant", "ally", "none", "informant"];
    LIST[pick_index(LIST.len(), &js::s(get(Some(captive), "id")), "spared")]
}

/// Награда за сдачу страже из XP стат-блока (`captiveBountyCp`).
pub fn captive_bounty_cp(captive: &Value) -> i64 {
    let xp = integer(get(Some(captive), "xp"), 0).max(0) as f64;
    clamp(js::round(xp / 5.0) * 10.0, 20.0, 2_000.0) as i64
}

fn world_node_for<'a>(state: &'a Value, value: Option<&Value>) -> Option<&'a Value> {
    let wanted = comparable(value);
    if wanted.is_empty() {
        return None;
    }
    array(get(get(Some(state), "worldMap"), "locations"))
        .iter()
        .find(|node| comparable(get(Some(node), "id")) == wanted || comparable(get(Some(node), "name")) == wanted)
}

/// Есть ли в текущей сцене кому передать пленного (`captiveSettlementFor`).
pub fn captive_settlement_for(state: &Value) -> Option<Value> {
    let location_id = string(scene_location_id(state));
    let node = world_node_for(state, Some(&location_id)).or_else(|| world_node_for(state, get(get(Some(state), "scene"), "location")))?;
    let kind = js::string(get(Some(node), "kind"));
    if !SETTLEMENT_LOCATION_KINDS.contains(&kind.as_str()) {
        return None;
    }
    Some(json!({ "id": js::string(get(Some(node), "id")), "name": text(get(Some(node), "name"), 180), "kind": kind }))
}

/// Фракции жителей текущей сцены без самих пленных (`localFactionIds`).
pub fn local_faction_ids(state: &Value) -> Vec<String> {
    let captive_npc_ids: IndexSet<String> = held_captives(state).iter().map(|captive| js::s(captive.get("npc_id"))).collect();
    let mut ids: IndexSet<String> = IndexSet::new();
    for npc in present_scene_npcs(state) {
        if captive_npc_ids.contains(&js::string(npc.get("id"))) {
            continue;
        }
        for faction in faction_ids_for_npc(Some(&npc)) {
            ids.insert(faction);
        }
    }
    let mut ids: Vec<String> = ids.into_iter().collect();
    ids.sort_by(|a, b| utf16_cmp(a, b));
    ids.truncate(8);
    ids
}

fn world_minute_of(state: &Value, world_minute: Option<&Value>) -> i64 {
    let source = coalesce(world_minute, get(get(get(Some(state), "mechanics"), "world_time"), "elapsed_minutes"));
    integer(source, 0).max(0)
}

/// Команды голода по мировым часам (`planCaptiveNeglectCommands`); не больше
/// двенадцати за раз.
pub fn plan_captive_neglect_commands(state: &Value, world_minute: Option<&Value>) -> Vec<Value> {
    let minute = world_minute_of(state, world_minute);
    let mut commands = Vec::new();
    for captive in held_captives(state) {
        let fed = js::safe_int(captive.get("last_fed_at_minutes"), 0);
        let neglected = js::safe_int(captive.get("neglected_at_minutes"), 0);
        if minute - fed.max(neglected) < CAPTIVE_FEED_INTERVAL_MINUTES {
            continue;
        }
        commands.push(json!({ "command_type": "NeglectCaptive", "captive_id": captive["id"], "at_minutes": minute }));
        if commands.len() >= 12 {
            break;
        }
    }
    commands
}

/// Полезная нагрузка `CaptiveNeglected` (`captiveNeglectedPayload`).
pub fn captive_neglected_payload(captive: &Value, minute: Option<&Value>) -> Value {
    let at = integer(minute, 0).max(0);
    let captive_ref = Some(captive);
    let hours = (js_max(0.0, at as f64 - js::number(get(captive_ref, "last_fed_at_minutes"))) / 60.0).floor();
    let mut payload = Map::new();
    insert_raw(&mut payload, "captive_id", get(captive_ref, "id"));
    insert_raw(&mut payload, "npc_id", get(captive_ref, "npc_id"));
    insert_raw(&mut payload, "captive_name", get(captive_ref, "name"));
    payload.insert("hours_without_food".into(), js::num(hours));
    payload.insert("at_minutes".into(), json!(at));
    payload.insert("policy_id".into(), string(CAPTIVES_POLICY_ID));
    Value::Object(payload)
}

/// Голод пленных в том же коммите, что и прошедшие сутки (`planCaptiveNeglectDrafts`).
pub fn plan_captive_neglect_drafts(state: &Value, world_minute: Option<&Value>) -> Vec<Value> {
    let minute = json!(world_minute_of(state, world_minute));
    plan_captive_neglect_commands(state, Some(&minute))
        .into_iter()
        .filter_map(|command| {
            let captive = captive_for(state, command.get("captive_id"))?;
            Some(json!({
                "event_type": "CaptiveNeglected",
                "visibility": "party",
                "payload": captive_neglected_payload(&captive, Some(&minute)),
                "target_ids": [captive["npc_id"]],
            }))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Проекция и редьюсер
// ---------------------------------------------------------------------------

/// Один пленный глазами отряда (`captiveForViewer`): без `known_fact_ids`,
/// `stat_block_id` и `xp`, со счётчиком `pending_knowledge`. `None` — запись
/// не проходит нормализацию.
pub fn captive_for_viewer(captive: Option<&Value>) -> Option<Value> {
    let mut normalized = safe_captive(captive)?;
    let known = normalized.get("known_fact_ids").and_then(Value::as_array).map_or(0, Vec::len) as i64;
    let revealed = normalized.get("revealed_fact_ids").and_then(Value::as_array).map_or(0, Vec::len) as i64;
    normalized.shift_remove("known_fact_ids");
    normalized.shift_remove("stat_block_id");
    normalized.shift_remove("xp");
    normalized.insert("pending_knowledge".into(), json!((known - revealed).max(0)));
    Some(Value::Object(normalized))
}

/// Реестр пленных глазами зрителя (`captivesForViewer`).
pub fn captives_for_viewer(state: &Value, viewer: &Value) -> Value {
    let captives = captive_list(state);
    if js::is_true(get(Some(viewer), "isAdmin")) {
        return json!({ "schema_version": CAPTIVES_SCHEMA_VERSION, "captives": captives });
    }
    let visible: Vec<Value> = captives.iter().filter_map(|captive| captive_for_viewer(Some(captive))).collect();
    json!({ "schema_version": CAPTIVES_SCHEMA_VERSION, "captives": visible })
}

fn is_normalized_registry(input: Option<&Value>) -> bool {
    get(input, "schema_version").and_then(Value::as_f64) == Some(CAPTIVES_SCHEMA_VERSION as f64) && matches!(get(input, "captives"), Some(Value::Array(_)))
}

/// Пересобрать реестр с новыми записями (`normalizeCaptivesState({ ...normalized, captives })`).
fn rebuilt(captives: Vec<Value>) -> Value {
    normalize_captives_state(Some(&json!({ "captives": captives })))
}

/// `Math.max(0, integer(value, fallback))` с сырым запасом JS.
fn max0_or(value: Option<&Value>, fallback: Option<&Value>) -> Value {
    match safe_integer(value) {
        Some(number) => json!(number.max(0)),
        None => f64_value(js_max(0.0, js::number(fallback))),
    }
}

/// Редьюсер реестра (`applyCaptiveEvent`). Третий аргумент — уже применённое
/// состояние: из него берётся время кампании для `NpcDied`.
pub fn apply_captive_event(input: Option<&Value>, event: &Value, state: &Value) -> Value {
    let event_type = js::s(get(Some(event), "event_type"));
    let empty = json!({});
    let payload = coalesce(get(Some(event), "payload"), None).unwrap_or(&empty);
    let payload_ref = Some(payload);
    let normalized = if is_normalized_registry(input) { input.cloned().unwrap_or(Value::Null) } else { normalize_captives_state(input) };
    let entries: Vec<Value> = array(normalized.get("captives")).to_vec();
    let patch = |captive_id: Option<&Value>, update: &dyn Fn(&Value) -> Map<String, Value>| -> Value {
        let expected = text(captive_id, 120);
        if expected.is_empty() {
            return normalized.clone();
        }
        rebuilt(entries.iter().map(|captive| if is_str(get(Some(captive), "id"), &expected) { Value::Object(update(captive)) } else { captive.clone() }).collect())
    };
    match event_type.as_str() {
        "CaptiveTaken" => {
            let Some(captive) = safe_captive(get(payload_ref, "captive")) else { return normalized };
            let id = js::s(captive.get("id"));
            if entries.iter().any(|entry| is_str(get(Some(entry), "id"), &id)) {
                return normalized;
            }
            let mut next = entries.clone();
            next.push(Value::Object(captive));
            rebuilt(next)
        }
        "NpcDied" => {
            let npc_id = text(get(payload_ref, "npc_id"), 120);
            let held = |captive: &Value| is_str(get(Some(captive), "npc_id"), &npc_id) && is_str(get(Some(captive), "status"), "held");
            if npc_id.is_empty() || !entries.iter().any(held) {
                return normalized;
            }
            let minutes = f64_value(campaign_elapsed_minutes(state));
            rebuilt(
                entries
                    .iter()
                    .map(|captive| {
                        if held(captive) {
                            let mut next = spread(Some(captive));
                            next.insert("status".into(), string("dead"));
                            next.insert("resolution".into(), string("killed"));
                            next.insert("resolved_at_minutes".into(), minutes.clone());
                            Value::Object(next)
                        } else {
                            captive.clone()
                        }
                    })
                    .collect(),
            )
        }
        "CaptiveMoved" => patch(get(payload_ref, "captive_id"), &|captive| {
            let mut next = spread(Some(captive));
            next.insert("location_id".into(), string(text(get(payload_ref, "location_id"), 180)));
            next.insert("location_name".into(), string(text(get(payload_ref, "location_name"), 180)));
            next
        }),
        "CaptiveInterrogated" => patch(get(payload_ref, "captive_id"), &|captive| {
            let mut next = spread(Some(captive));
            next.insert("interrogations".into(), js_plus_one(get(Some(captive), "interrogations")));
            if js::is_true(get(payload_ref, "success")) && js::truthy(get(payload_ref, "fact_id")) {
                let mut revealed = iterate(get(Some(captive), "revealed_fact_ids"));
                revealed.push(string(text(get(payload_ref, "fact_id"), 120)));
                let mut unique: Vec<Value> = Vec::new();
                for entry in revealed {
                    if !unique.iter().any(|seen| same_value_zero(seen, &entry)) {
                        unique.push(entry);
                    }
                }
                next.insert("revealed_fact_ids".into(), Value::Array(unique));
            }
            next
        }),
        "CaptiveFed" => patch(get(payload_ref, "captive_id"), &|captive| {
            let mut next = spread(Some(captive));
            next.insert("last_fed_at_minutes".into(), max0_or(get(payload_ref, "at_minutes"), get(Some(captive), "last_fed_at_minutes")));
            next.insert("neglected_at_minutes".into(), Value::Null);
            next
        }),
        "CaptiveNeglected" => patch(get(payload_ref, "captive_id"), &|captive| {
            let mut next = spread(Some(captive));
            let fallback = coalesce(get(Some(captive), "neglected_at_minutes"), Some(&json!(0))).cloned();
            next.insert("neglected_at_minutes".into(), max0_or(get(payload_ref, "at_minutes"), fallback.as_ref()));
            next
        }),
        "CaptiveReleased" | "CaptiveHandedOver" | "CaptiveExecuted" => patch(get(payload_ref, "captive_id"), &|captive| {
            let mut next = spread(Some(captive));
            let (status, resolution) = match event_type.as_str() {
                "CaptiveReleased" => ("released", "released"),
                "CaptiveHandedOver" => ("handed_over", "handed_over"),
                _ => ("dead", "executed"),
            };
            next.insert("status".into(), string(status));
            next.insert("resolution".into(), string(resolution));
            if event_type == "CaptiveReleased" {
                let disposition = match get(payload_ref, "disposition") {
                    Some(Value::String(value)) if DISPOSITIONS.contains(&value.as_str()) => value.clone(),
                    _ => "none".into(),
                };
                next.insert("disposition".into(), string(disposition));
            }
            let fallback = coalesce(get(Some(captive), "resolved_at_minutes"), Some(&json!(0))).cloned();
            next.insert("resolved_at_minutes".into(), max0_or(get(payload_ref, "at_minutes"), fallback.as_ref()));
            next
        }),
        _ => normalized,
    }
}

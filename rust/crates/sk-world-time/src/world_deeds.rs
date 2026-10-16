//! Перенос `server/world-deeds.mjs`: свидетели и слухи — мир узнаёт о
//! поступках отряда.
//!
//! Петля в три шага, как в JS:
//!
//! 1. **Поступок.** Летопись `state.world_deeds` выводится редьюсером из уже
//!    подтверждённых событий ([`apply_world_deed_event`]); каждая запись несёт
//!    место, время кампании и список свидетелей — живых NPC сцены.
//! 2. **Слух.** Поступок со свидетелями рождает `RecordRumor` через
//!    детерминированную задержку по тяжести и дальше — по суткам на шаг графа
//!    мира ([`rumor_spread_targets`], [`plan_world_rumor_tick`]).
//! 3. **Реакция.** Дошедший слух двигает репутацию фракций держателя
//!    (`FactionReputationAdjusted`, [`plan_world_rumor_reputation`]).
//!
//! Слухи и летопись пишутся с видимостью `gm_only`: игрок узнаёт их из уст NPC.

use std::collections::HashSet;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::{js, text as jstext};
use sk_npc_world::npc_positioning::{normalize_npc_world_state, present_scene_npcs, scene_location_id};
use sk_society::reputation_policy::faction_ids_for_npc;
use sk_world_life::captives::held_captive_for_npc;

use crate::common::{
    array, coalesce, digest, get, integer, integer_or, is_prototype_key, is_safe_id, is_str, prototype_member_string, replace_all_literal, string, text, text_str, unique, utf16_cmp,
};

pub const WORLD_DEEDS_SCHEMA_VERSION: i64 = 1;
pub const WORLD_DEEDS_POLICY_ID: &str = "skazanie:world-deeds-v1";
pub const WORLD_RUMOR_POLICY_ID: &str = "skazanie:world-rumor-v1";

/// Сутки игрового времени на один шаг по графу мира.
pub const RUMOR_HOP_MINUTES: i64 = 1_440;
/// Дальше двух шагов слух в этой редакции не уходит.
pub const MAX_RUMOR_HOPS: i64 = 2;
/// Крупный дар — от 5 зм.
pub const GENEROSITY_THRESHOLD_CP: i64 = 500;
const MAX_DEEDS: usize = 200;
const MAX_WITNESSES: usize = 40;

/// Задержка рождения местной молвы по тяжести (`DEED_LOCAL_DELAY_MINUTES`).
pub const DEED_LOCAL_DELAY_MINUTES: [(&str, i64); 3] = [("grave", 360), ("major", 720), ("minor", 1_440)];

/// Базовая поправка репутации у прямых свидетелей (`DEED_REPUTATION_BASE`).
const DEED_REPUTATION_BASE: [(&str, f64); 3] = [("grave", 8.0), ("major", 5.0), ("minor", 2.0)];

/// Вид поступка из закрытой серверной таблицы.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeedKind {
    pub alignment: &'static str,
    pub severity: &'static str,
    pub label: &'static str,
}

const fn kind(alignment: &'static str, severity: &'static str, label: &'static str) -> DeedKind {
    DeedKind { alignment, severity, label }
}

/// `DEED_KINDS` в порядке JS.
pub const DEED_KINDS: [(&str, DeedKind); 15] = [
    ("murder", kind("dark", "grave", "Убийство")),
    ("cruelty", kind("dark", "grave", "Жестокость")),
    ("treachery", kind("dark", "grave", "Вероломство")),
    ("arson", kind("dark", "major", "Поджог")),
    ("theft", kind("dark", "major", "Кража")),
    ("destruction", kind("dark", "major", "Разрушение")),
    ("violence", kind("dark", "minor", "Насилие")),
    ("cheating", kind("dark", "minor", "Шулерство")),
    ("break_in", kind("dark", "minor", "Взлом")),
    ("vandalism", kind("dark", "minor", "Погром")),
    ("bribery_attempt", kind("dark", "minor", "Попытка подкупа")),
    ("promise_broken", kind("dark", "minor", "Нарушенное слово")),
    ("rescue", kind("bright", "major", "Спасение")),
    ("generosity", kind("bright", "major", "Щедрость")),
    ("promise_kept", kind("bright", "minor", "Сдержанное слово")),
];

/// Вид поступка по имени (собственный ключ таблицы).
pub fn deed_kind(name: &str) -> Option<&'static DeedKind> {
    DEED_KINDS.iter().find(|(key, _)| *key == name).map(|(_, entry)| entry)
}

/// `DEED_KINDS[name]` истинно: собственный вид или ключ `Object.prototype`.
fn known_kind(name: &str) -> bool {
    deed_kind(name).is_some() || is_prototype_key(name)
}

fn severity_of(name: &str) -> &'static str {
    deed_kind(name).map_or("minor", |entry| entry.severity)
}

fn alignment_of(name: &str) -> &'static str {
    deed_kind(name).map_or("dark", |entry| entry.alignment)
}

fn local_delay(severity: &str) -> Option<i64> {
    DEED_LOCAL_DELAY_MINUTES.iter().find(|(key, _)| *key == severity).map(|(_, value)| *value)
}

/// Три ступени точности пересказа (`RUMOR_PHRASES`).
const RUMOR_PHRASES: [(&str, [&str; 3]); 14] = [
    ("murder", [
        "В «{place}» случилось убийство: погиб(ла) {what}. Свидетели указывают: {who}.",
        "Говорят, в «{place}» кто-то из чужаков убил человека.",
        "Слыхал, будто в «{place}» пришлые устроили резню. Врут, поди.",
    ]),
    ("cruelty", [
        "В «{place}» расправились со связанным. Погиб(ла) {what}. Свидетели указывают: {who}.",
        "Говорят, в «{place}» чужаки не пощадили пленного.",
        "Слыхал, будто те пришлые пленных не берут — а берут, так лучше бы убили сразу.",
    ]),
    ("treachery", [
        "В «{place}» ударили под перемирием. Обманутая сторона — {what}. Свидетели указывают: {who}.",
        "Говорят, в «{place}» чужаки позвали говорить, а ударили в спину.",
        "Слыхал, будто тем пришлым слово не слово: зовут на переговоры и режут.",
    ]),
    ("violence", [
        "В «{place}» человека избили до крови: пострадал(а) {what}. Свидетели указывают: {who}.",
        "Говорят, в «{place}» чужаки кого-то избили.",
        "Слыхал, будто в «{place}» пришлые чуть не убили человека.",
    ]),
    ("cheating", [
        "В «{place}» поймали шулера за костями. Обыгрывали вот кого: {what}. Свидетели указывают: {who}.",
        "Говорят, в «{place}» чужаки играют краплёными костями.",
        "Слыхал, будто с теми пришлыми за кости лучше не садиться.",
    ]),
    ("arson", [
        "В «{place}» был пожар. Горело вот что: {what}. Свидетели указывают: {who}.",
        "Говорят, в «{place}» из-за чужаков случился пожар.",
        "Слыхал, будто «{place}» едва не выгорело дотла по вине проезжих.",
    ]),
    ("vandalism", [
        "В «{place}» переломали хозяйское добро. Сломано вот что: {what}. Свидетели указывают: {who}.",
        "Говорят, в «{place}» чужаки переломали хозяйское добро.",
        "Слыхал, будто в «{place}» проезжие разгромили целый дом.",
    ]),
    ("break_in", [
        "В «{place}» ковырялись в чужом замке. Взломано вот что: {what}. Свидетели указывают: {who}.",
        "Говорят, в «{place}» чужаки лезут в запертое отмычкой.",
        "Слыхал, будто тем пришлым ни один замок не помеха.",
    ]),
    ("theft", [
        "В «{place}» взяли чужое. Пропало вот что: {what}. Свидетели указывают: {who}.",
        "Говорят, в «{place}» чужаки взяли чужое.",
        "Слыхал, будто в «{place}» проезжие обобрали полгорода.",
    ]),
    ("destruction", [
        "В «{place}» ломились силой. Не уцелело вот что: {what}. Свидетели указывают: {who}.",
        "Говорят, в «{place}» чужаки вышибли чужую дверь.",
        "Слыхал, будто в «{place}» проезжие вламываются куда захотят.",
    ]),
    ("promise_broken", [
        "В «{place}» слово дали и не сдержали. Обманутая сторона — {what}. Свидетели указывают: {who}.",
        "Говорят, слову этих чужаков в «{place}» верить нельзя.",
        "Слыхал, будто те пришлые обманули всех, кому что-то обещали.",
    ]),
    ("rescue", [
        "В «{place}» заслонили местных и отбили нападение. Свидетели указывают: {who}.",
        "Говорят, в «{place}» чужаки заступились за местных.",
        "Слыхал, будто в «{place}» пришлые кого-то спасли. Может, и правда.",
    ]),
    ("generosity", [
        "В «{place}» одарили и ничего не взяли взамен. Подарок — {what}. Свидетели указывают: {who}.",
        "Говорят, в «{place}» чужаки щедро одарили местных.",
        "Слыхал, будто те проезжие золото раздают направо и налево.",
    ]),
    ("promise_kept", [
        "В «{place}» слово дали и сдержали. Вторая сторона — {what}. Свидетели указывают: {who}.",
        "Говорят, слову этих чужаков в «{place}» верить можно.",
        "Слыхал, будто те пришлые слово держат. Редкость нынче.",
    ]),
];

/// Запасные формулировки при рассинхроне `DEED_KINDS` и таблицы фраз.
const FALLBACK_RUMOR_PHRASES: [&str; 3] = [
    "В «{place}» случилось нехорошее. Речь вот о чём: {what}. Свидетели указывают: {who}.",
    "Говорят, в «{place}» чужаки чем-то отличились.",
    "Слыхал, будто в «{place}» проезжие такое устроили — не перескажешь.",
];

/// Русские имена видов обстановки, именительный падеж (`PROP_KIND_LABELS`).
const PROP_KIND_LABELS: [(&str, &str); 6] = [
    ("container", "чужие пожитки"),
    ("corpse", "останки погибшего"),
    ("relic", "святыня"),
    ("campfire", "костёр"),
    ("lore", "обстановка"),
    ("furnishing", "обстановка"),
];

/// Что ломают силой: у двери в движке нет ни имени, ни хозяина.
const FORCED_DOOR_LABEL: &str = "дверь";

/// Типы событий, в которых поступок вообще может обнаружиться.
const DEED_EVENT_TYPES: [&str; 14] = [
    "NpcDied",
    "NpcHarmed",
    "SceneObjectOperated",
    "DoorForced",
    "NpcPromiseResolved",
    "ItemTransferred",
    "WitnessConsequencePropagated",
    "CaptiveNeglected",
    "TruceBroken",
    "TavernCheatCaught",
    "NpcPickpocketNoticed",
    "MerchantDenouncedThief",
    "NpcBribeRefused",
    "LockpickNoticed",
];

/// `text(value, 180).toLocaleLowerCase('ru')`.
fn comparable(value: Option<&Value>) -> String {
    jstext::lower(&text(value, 180))
}

fn digest20(parts: &[String]) -> String {
    digest(parts)[..20].to_string()
}

/// `[...new Set(list.map((entry) => text(entry, 120)).filter(Boolean))]`.
fn text_list(value: Option<&Value>, maximum: usize) -> Vec<String> {
    unique(array(value).iter().map(|entry| text(Some(entry), maximum)).filter(|entry| !entry.is_empty()))
}

fn sorted(mut items: Vec<String>) -> Vec<String> {
    items.sort_by(|left, right| utf16_cmp(left, right));
    items
}

fn strings(items: &[String]) -> Value {
    Value::Array(items.iter().cloned().map(Value::String).collect())
}

fn str_list(value: Option<&Value>) -> Vec<String> {
    array(value).iter().map(|entry| js::s(Some(entry))).collect()
}

/// `safeDeed(value)`. Значение `null` в JS роняет нормализацию
/// (`null.kind`); здесь такая запись просто отбрасывается.
fn safe_deed(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    let source = Some(value);
    let kind_name = text(get(source, "kind"), 40);
    if !known_kind(&kind_name) {
        return None;
    }
    let id = text(get(source, "id"), 120);
    if !is_safe_id(&id, 119) {
        return None;
    }
    let at = integer(get(source, "at_minutes"), 0).max(0) as f64;
    let severity_raw = js::string(get(source, "severity"));
    let severity = if ["grave", "major", "minor"].contains(&severity_raw.as_str()) { severity_raw } else { severity_of(&kind_name).to_string() };
    let mut witness_ids = sorted(text_list(get(source, "witness_ids"), 120));
    witness_ids.truncate(MAX_WITNESSES);
    let alignment_raw = js::string(get(source, "alignment"));
    let alignment = if ["dark", "bright"].contains(&alignment_raw.as_str()) { alignment_raw } else { alignment_of(&kind_name).to_string() };
    let mut actor_ids = text_list(get(source, "actor_ids"), 120);
    actor_ids.truncate(12);
    let mut actor_names = text_list(get(source, "actor_names"), 120);
    actor_names.truncate(12);
    let mut source_event_ids = text_list(get(source, "source_event_ids"), 120);
    source_event_ids.truncate(10);
    let delay = local_delay(&severity).unwrap_or(RUMOR_HOP_MINUTES) as f64;
    let spread = integer_or(get(source, "spread_at_minutes"), at + delay).max(at);
    let mut factions = sorted(text_list(get(source, "reputation_faction_ids"), 120));
    factions.truncate(60);
    let secret = witness_ids.is_empty();
    Some(json!({
        "id": id,
        "kind": kind_name,
        "alignment": alignment,
        "severity": severity,
        "actor_ids": strings(&actor_ids),
        "actor_names": strings(&actor_names),
        "subject": text(get(source, "subject"), 180),
        "location_id": text(get(source, "location_id"), 180),
        "location_name": text(get(source, "location_name"), 180),
        "at_minutes": js::num(at),
        "witness_ids": strings(&witness_ids),
        "secret": secret,
        "summary": text(get(source, "summary"), 500),
        "source_event_ids": strings(&source_event_ids),
        "spread_at_minutes": js::num(spread),
        "reputation_faction_ids": strings(&factions),
        "policy_id": WORLD_DEEDS_POLICY_ID,
    }))
}

fn normalize_deeds(deeds: &[Value]) -> Value {
    let mut out: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for raw in deeds {
        let Some(deed) = safe_deed(Some(raw)) else { continue };
        let id = js::s(deed.get("id"));
        if !seen.insert(id) {
            continue;
        }
        out.push(deed);
    }
    let start = out.len().saturating_sub(MAX_DEEDS);
    json!({ "schema_version": WORLD_DEEDS_SCHEMA_VERSION, "deeds": out.split_off(start) })
}

/// `normalizeWorldDeedsState(input)`.
pub fn normalize_world_deeds_state(input: Option<&Value>) -> Value {
    let source = input.filter(|value| js::is_plain(Some(value)));
    normalize_deeds(array(get(source, "deeds")))
}

fn hero_name_for(state: &Value, actor_id: &str) -> String {
    let hero = array(get(Some(state), "players")).iter().find(|player| js::s(get(Some(player), "id")) == actor_id);
    let character = get(hero, "character");
    text(if js::truthy(character) { character } else { get(hero, "name") }, 120)
}

fn party_label(state: &Value, actor_names: &[String]) -> String {
    if !actor_names.is_empty() {
        return actor_names.join(", ");
    }
    let name = text(get(Some(state), "partyName"), 120);
    if name.is_empty() {
        "отряд".to_string()
    } else {
        name
    }
}

/// Свидетели — живые NPC текущей сцены, по возрастанию id.
fn scene_witness_ids(state: &Value) -> Vec<String> {
    sorted(present_scene_npcs(state).iter().map(|npc| js::string(get(Some(npc), "id"))).collect())
}

fn social_list<'a>(state: &'a Value, key: &str) -> &'a [Value] {
    array(get(get(Some(state), "social"), key))
}

fn promise_for<'a>(state: &'a Value, promise_id: Option<&Value>) -> Option<&'a Value> {
    let expected = js::s(promise_id);
    social_list(state, "promises").iter().find(|entry| js::s(get(Some(entry), "id")) == expected)
}

fn npc_name_for(state: &Value, npc_id: Option<&Value>) -> String {
    let expected = js::s(npc_id);
    let npc = social_list(state, "npcs").iter().find(|entry| js::s(get(Some(entry), "id")) == expected);
    let name = text(get(npc, "name"), 160);
    if name.is_empty() {
        expected
    } else {
        name
    }
}

fn or_else(value: String, fallback: impl FnOnce() -> String) -> String {
    if value.is_empty() {
        fallback()
    } else {
        value
    }
}

/// Распознанный поступок без id и времени.
struct Recognized {
    kind: &'static str,
    key: String,
    severity: Option<&'static str>,
    subject: String,
    /// Уже `text(entry, 120)`; пустые отбросит `deed_from_event`.
    actor_ids: Vec<String>,
    witness_ids: Option<Vec<String>>,
}

/// `[x].filter(Boolean)` и затем `text(entry, 120)`.
fn filtered_actor(value: Option<&Value>) -> Vec<String> {
    if js::truthy(value) {
        vec![text(value, 120)]
    } else {
        Vec::new()
    }
}

/// `[...new Set([first, ...sceneWitnessIds(state)])].filter(Boolean).sort()`.
fn with_scene_witnesses(first: String, state: &Value) -> Vec<String> {
    let mut all = vec![first];
    all.extend(scene_witness_ids(state));
    sorted(unique(all).into_iter().filter(|entry| !entry.is_empty()).collect())
}

fn prop_kind_label(name: &str) -> String {
    if let Some((_, label)) = PROP_KIND_LABELS.iter().find(|(key, _)| *key == name) {
        return (*label).to_string();
    }
    if is_prototype_key(name) {
        // `PROP_KIND_LABELS['constructor']` — встроенная функция, и в предмет
        // поступка попадает её текст (так ведёт себя JS).
        return prototype_member_string(name);
    }
    "обстановка".to_string()
}

fn recognize_deed(state: &Value, event: &Value) -> Option<Recognized> {
    let event_ref = Some(event);
    let kind_name = js::s(get(event_ref, "event_type"));
    let payload = get(event_ref, "payload");
    let event_actor = get(event_ref, "actor_id");
    let field = |key: &str| get(payload, key);
    let hero_or_actor = || filtered_actor(coalesce(field("hero_id"), event_actor));
    match kind_name.as_str() {
        "CaptiveNeglected" => {
            let victim = text(field("npc_id"), 120);
            Some(Recognized {
                kind: "cruelty",
                key: text(field("captive_id"), 120),
                subject: or_else(text(field("captive_name"), 160), || npc_name_for(state, field("npc_id"))),
                actor_ids: hero_or_actor(),
                severity: None,
                witness_ids: Some(scene_witness_ids(state).into_iter().filter(|npc_id| *npc_id != victim).collect()),
            })
        }
        "TavernCheatCaught" => {
            let npc_id = text(field("npc_id"), 120);
            Some(Recognized {
                kind: "cheating",
                key: or_else(npc_id.clone(), || text(field("hero_id"), 120)),
                subject: or_else(or_else(text(field("npc_name"), 160), || npc_name_for(state, Some(&string(npc_id.clone())))), || "соперник за костями".to_string()),
                actor_ids: hero_or_actor(),
                severity: None,
                witness_ids: Some(with_scene_witnesses(npc_id, state)),
            })
        }
        "NpcBribeRefused" => {
            let npc_id = text(field("npc_id"), 120);
            Some(Recognized {
                kind: "bribery_attempt",
                key: or_else(npc_id.clone(), || text(field("hero_id"), 120)),
                subject: or_else(npc_name_for(state, Some(&string(npc_id.clone()))), || "собеседник".to_string()),
                actor_ids: hero_or_actor(),
                severity: None,
                witness_ids: Some(with_scene_witnesses(npc_id, state)),
            })
        }
        "MerchantDenouncedThief" => {
            let merchant_id = text(field("merchant_id"), 120);
            Some(Recognized {
                kind: "theft",
                key: or_else(merchant_id.clone(), || text(field("hero_id"), 120)),
                subject: or_else(text(field("item_name"), 160), || "чужая вещь".to_string()),
                actor_ids: hero_or_actor(),
                severity: None,
                witness_ids: Some(with_scene_witnesses(merchant_id, state)),
            })
        }
        "LockpickNoticed" => {
            let witness_ids = sorted(text_list(field("witness_ids"), 120));
            if witness_ids.is_empty() {
                return None;
            }
            Some(Recognized {
                kind: "break_in",
                key: text(field("target_id"), 120),
                severity: Some(if text(field("severity"), 20) == "major" { "major" } else { "minor" }),
                subject: or_else(text(field("target_label"), 160), || "чужой замок".to_string()),
                actor_ids: hero_or_actor(),
                witness_ids: Some(witness_ids),
            })
        }
        "NpcPickpocketNoticed" => {
            let npc_id = text(field("npc_id"), 120);
            Some(Recognized {
                kind: "theft",
                key: or_else(npc_id.clone(), || text(field("hero_id"), 120)),
                subject: or_else(or_else(text(field("npc_name"), 160), || npc_name_for(state, Some(&string(npc_id.clone())))), || "прохожий".to_string()),
                actor_ids: hero_or_actor(),
                severity: None,
                witness_ids: Some(with_scene_witnesses(npc_id, state)),
            })
        }
        "TruceBroken" => {
            if text(field("broken_by"), 30) != "party" {
                return None;
            }
            let leader_id = text(field("leader_id"), 120);
            Some(Recognized {
                kind: "treachery",
                key: or_else(leader_id.clone(), || text(field("actor_id"), 120)),
                subject: or_else(or_else(text(field("leader_name"), 160), || npc_name_for(state, Some(&string(leader_id.clone())))), || "противник".to_string()),
                actor_ids: filtered_actor(coalesce(field("actor_id"), event_actor)),
                severity: None,
                witness_ids: Some(with_scene_witnesses(leader_id, state)),
            })
        }
        "NpcDied" => {
            let captive = held_captive_for_npc(state, field("npc_id"));
            let subject = or_else(text(field("npc_name"), 160), || npc_name_for(state, field("npc_id")));
            let actor_ids = vec![text(coalesce(field("source_actor_id"), event_actor), 120)];
            if let Some(captive) = captive {
                let subject = or_else(subject, || text(captive.get("name"), 160));
                return Some(Recognized { kind: "cruelty", key: text(captive.get("id"), 120), subject, actor_ids, severity: None, witness_ids: None });
            }
            Some(Recognized { kind: "murder", key: text(field("npc_id"), 120), subject, actor_ids, severity: None, witness_ids: None })
        }
        "NpcHarmed" => {
            if integer(field("hp_after"), 0) <= 0 {
                return None;
            }
            Some(Recognized {
                kind: "violence",
                key: text(field("npc_id"), 120),
                subject: or_else(text(field("npc_name"), 160), || npc_name_for(state, field("npc_id"))),
                actor_ids: vec![text(coalesce(field("source_actor_id"), event_actor), 120)],
                severity: None,
                witness_ids: None,
            })
        }
        "SceneObjectOperated" => {
            let what = prop_kind_label(&text(field("kind"), 40));
            let key = text(field("prop_id"), 120);
            let actor_ids = vec![text(event_actor, 120)];
            let intent = field("intent");
            if is_str(intent, "ignite") {
                return Some(Recognized { kind: "arson", key, subject: what, actor_ids, severity: None, witness_ids: None });
            }
            if is_str(intent, "topple") {
                return Some(Recognized { kind: "vandalism", key, subject: what, actor_ids, severity: None, witness_ids: None });
            }
            if is_str(intent, "take") {
                let witness_ids = scene_witness_ids(state);
                if witness_ids.is_empty() {
                    return None;
                }
                return Some(Recognized { kind: "theft", key, subject: what, actor_ids, severity: None, witness_ids: Some(witness_ids) });
            }
            None
        }
        "DoorForced" if js::is_true(field("success")) => {
            let witness_ids = scene_witness_ids(state);
            if witness_ids.is_empty() {
                return None;
            }
            Some(Recognized {
                kind: "destruction",
                key: text(field("door_id"), 120),
                subject: FORCED_DOOR_LABEL.to_string(),
                actor_ids: vec![text(event_actor, 120)],
                severity: None,
                witness_ids: Some(witness_ids),
            })
        }
        "NpcPromiseResolved" => {
            let status = text(field("status"), 30);
            if status != "broken" && status != "fulfilled" {
                return None;
            }
            let promise = promise_for(state, field("promise_id")).filter(|promise| js::truthy(Some(promise)));
            let promise = Some(promise?);
            Some(Recognized {
                kind: if status == "broken" { "promise_broken" } else { "promise_kept" },
                key: text(field("promise_id"), 120),
                subject: npc_name_for(state, get(promise, "npc_id")),
                actor_ids: vec![text(get(promise, "hero_id"), 120)],
                severity: None,
                // `String(promise.npc_id)`: без поля это строка `undefined`.
                witness_ids: Some(with_scene_witnesses(js::string(get(promise, "npc_id")), state)),
            })
        }
        "ItemTransferred" if text(field("recipient_kind"), 40) == "npc" => {
            let item = field("item");
            let price = integer(get(item, "base_price_cp"), 0).max(0) as f64 * integer(field("quantity"), 1).max(1) as f64;
            if price < GENEROSITY_THRESHOLD_CP as f64 {
                return None;
            }
            Some(Recognized {
                kind: "generosity",
                key: text(field("item_id"), 120),
                subject: or_else(text(get(item, "name"), 160), || "дар".to_string()),
                actor_ids: vec![text(coalesce(field("from_actor_id"), event_actor), 120)],
                severity: None,
                witness_ids: Some(with_scene_witnesses(text(field("to_actor_id"), 120), state)),
            })
        }
        "WitnessConsequencePropagated" if text(field("outcome"), 30) == "helpful" => {
            let witness_ids = sorted(text_list(field("witness_ids"), 120));
            if witness_ids.is_empty() {
                return None;
            }
            Some(Recognized {
                kind: "rescue",
                key: text(field("source_event_id"), 120),
                subject: or_else(text(get(get(Some(state), "scene"), "location"), 180), || "местных".to_string()),
                actor_ids: Vec::new(),
                severity: None,
                witness_ids: Some(witness_ids),
            })
        }
        _ => None,
    }
}

fn summary_for(state: &Value, deed: &Value) -> String {
    let who = party_label(state, &str_list(deed.get("actor_names")));
    let place = or_else(js::s(deed.get("location_name")), || "неизвестном месте".to_string());
    let what = or_else(js::s(deed.get("subject")), || "—".to_string());
    let kind_name = js::s(deed.get("kind"));
    let line = match kind_name.as_str() {
        "murder" => format!("{who}: убийство — {what} ({place})"),
        "cruelty" => format!("{who}: жестокость к пленному — {what} ({place})"),
        "treachery" => format!("{who}: удар под перемирием — {what} ({place})"),
        "violence" => format!("{who}: побои — {what} ({place})"),
        "cheating" => format!("{who}: шулерство за костями — {what} ({place})"),
        "arson" => format!("{who}: поджог — {what} ({place})"),
        "vandalism" => format!("{who}: погром — {what} ({place})"),
        "bribery_attempt" => format!("{who}: попытка подкупа — {what} ({place})"),
        "theft" => format!("{who}: кража — {what} ({place})"),
        "break_in" => format!("{who}: взлом отмычками — {what} ({place})"),
        "destruction" => format!("{who}: разрушение — {what} ({place})"),
        "promise_broken" => format!("{who}: нарушенное слово — {what} ({place})"),
        "promise_kept" => format!("{who}: сдержанное слово — {what} ({place})"),
        "generosity" => format!("{who}: дар — {what} ({place})"),
        "rescue" => format!("{who}: защита людей ({place})"),
        other => format!("{who}: {other} ({place})"),
    };
    text_str(&line, 500)
}

/// `deedFromEvent(state, event)`: поступок из подтверждённого события или `None`.
pub fn deed_from_event(state: &Value, event: &Value) -> Option<Value> {
    let recognized = recognize_deed(state, event)?;
    let at = integer(js::path(state, &["mechanics", "world_time", "elapsed_minutes"]), 0).max(0) as f64;
    let witness_ids: Vec<String> = recognized
        .witness_ids
        .clone()
        .unwrap_or_else(|| scene_witness_ids(state))
        .iter()
        .map(|entry| text_str(entry, 120))
        .filter(|entry| !entry.is_empty())
        .collect();
    let actor_ids: Vec<String> = recognized.actor_ids.iter().filter(|entry| !entry.is_empty()).cloned().collect();
    let severity = recognized.severity.unwrap_or_else(|| severity_of(recognized.kind));
    let event_ref = Some(event);
    let id = format!(
        "deed:{}",
        digest20(&[
            js::s(coalesce(get(event_ref, "command_id"), get(event_ref, "event_id"))),
            js::s(get(event_ref, "event_type")),
            recognized.kind.to_string(),
            recognized.key.clone(),
            js::f64_string(at),
        ])
    );
    let actor_names: Vec<String> = actor_ids.iter().map(|actor_id| hero_name_for(state, actor_id)).filter(|name| !name.is_empty()).collect();
    let scene = get(Some(state), "scene");
    let source_event_ids: Vec<String> = [text(get(event_ref, "event_id"), 120)].into_iter().filter(|entry| !entry.is_empty()).collect();
    let delay = local_delay(severity).unwrap_or(RUMOR_HOP_MINUTES) as f64;
    let draft = json!({
        "id": id,
        "kind": recognized.kind,
        "alignment": alignment_of(recognized.kind),
        "severity": severity,
        "actor_ids": strings(&actor_ids),
        "actor_names": strings(&actor_names),
        "subject": recognized.subject,
        "location_id": scene_location_id(state),
        "location_name": text(coalesce(get(scene, "location"), get(scene, "title")), 180),
        "at_minutes": js::num(at),
        "witness_ids": strings(&witness_ids),
        "source_event_ids": strings(&source_event_ids),
        "spread_at_minutes": js::num(at + delay),
    });
    let mut deed = safe_deed(Some(&draft))?;
    let summary = summary_for(state, &deed);
    if let Value::Object(map) = &mut deed {
        map.insert("summary".into(), Value::String(summary));
    }
    Some(deed)
}

fn deeds_of(ledger: &Value) -> &[Value] {
    array(ledger.get("deeds"))
}

/// `applyWorldDeedEvent(input, event, state)`: редьюсер летописи.
pub fn apply_world_deed_event(input: Option<&Value>, event: &Value, state: &Value) -> Value {
    let event_ref = Some(event);
    let kind_name = js::s(get(event_ref, "event_type"));
    let is_current = matches!(get(input, "schema_version"), Some(Value::Number(number)) if number.as_f64() == Some(WORLD_DEEDS_SCHEMA_VERSION as f64))
        && matches!(get(input, "deeds"), Some(Value::Array(_)));
    let normalized = match input {
        Some(value) if is_current => value.clone(),
        _ => normalize_world_deeds_state(input),
    };
    if kind_name == "FactionReputationAdjusted" {
        let payload = get(event_ref, "payload");
        if text(get(get(payload, "provenance"), "policy"), 120) != WORLD_RUMOR_POLICY_ID {
            return normalized;
        }
        let deed_id = text(get(payload, "deed_id"), 120);
        let faction_id = text(get(payload, "faction_id"), 120);
        if deed_id.is_empty() || faction_id.is_empty() {
            return normalized;
        }
        let deeds: Vec<Value> = deeds_of(&normalized)
            .iter()
            .map(|deed| {
                if !is_str(deed.get("id"), &deed_id) {
                    return deed.clone();
                }
                let mut ids: Vec<Value> = match deed.get("reputation_faction_ids") {
                    Some(Value::Array(items)) => items.clone(),
                    Some(Value::String(text)) => text.chars().map(|ch| string(ch.to_string())).collect(),
                    _ => Vec::new(),
                };
                ids.push(string(faction_id.clone()));
                let mut copy = deed.clone();
                if let Value::Object(map) = &mut copy {
                    map.insert("reputation_faction_ids".into(), Value::Array(ids));
                }
                copy
            })
            .collect();
        return normalize_deeds(&deeds);
    }
    if !DEED_EVENT_TYPES.contains(&kind_name.as_str()) {
        return normalized;
    }
    let Some(deed) = deed_from_event(state, event) else { return normalized };
    let deed_id = js::s(deed.get("id"));
    if deeds_of(&normalized).iter().any(|entry| is_str(entry.get("id"), &deed_id)) {
        return normalized;
    }
    let mut deeds = deeds_of(&normalized).to_vec();
    deeds.push(deed);
    normalize_deeds(&deeds)
}

/// `worldDeedsFeed(state, { limit })`: лента ведущего, свежее сверху.
pub fn world_deeds_feed(state: &Value, options: &Value) -> Vec<Value> {
    let limit = match get(Some(options), "limit") {
        None => 30,
        some => integer(some, 30),
    };
    let ledger = normalize_world_deeds_state(get(Some(state), "world_deeds"));
    let mut deeds = deeds_of(&ledger).to_vec();
    deeds.sort_by(|left, right| {
        let left_at = js::number(left.get("at_minutes"));
        let right_at = js::number(right.get("at_minutes"));
        right_at
            .partial_cmp(&left_at)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| jstext::locale_compare(&js::s(left.get("id")), &js::s(right.get("id"))))
    });
    deeds.truncate(limit.clamp(1, 200) as usize);
    deeds
        .into_iter()
        .map(|mut deed| {
            let kind_name = js::s(deed.get("kind"));
            let label = deed_kind(&kind_name).map_or(kind_name.clone(), |entry| entry.label.to_string());
            let witness_count = array(deed.get("witness_ids")).len();
            if let Value::Object(map) = &mut deed {
                map.insert("label".into(), Value::String(label));
                map.insert("witness_count".into(), Value::from(witness_count));
            }
            deed
        })
        .collect()
}

// ---------------------------------------------------------------------------
// География: слух идёт по графу мира, а не по прямой
// ---------------------------------------------------------------------------

fn world_nodes(state: &Value) -> &[Value] {
    array(get(get(Some(state), "worldMap"), "locations"))
}

/// `worldNodeIdFor(state, value)`: id узла графа мира по id или названию;
/// значение — сам `node.id` (как в JS, не обязательно строка), иначе `""`.
pub fn world_node_id_for(state: &Value, value: Option<&Value>) -> Value {
    let wanted = text(value, 180);
    if wanted.is_empty() {
        return string("");
    }
    let key = jstext::lower(&text_str(&wanted, 180));
    let nodes = world_nodes(state);
    if let Some(node) = nodes.iter().find(|node| js::s(get(Some(node), "id")) == wanted) {
        if let Some(id) = coalesce(get(Some(node), "id"), None) {
            return id.clone();
        }
    }
    if let Some(node) = nodes.iter().find(|node| comparable(get(Some(node), "name")) == key) {
        if let Some(id) = coalesce(get(Some(node), "id"), None) {
            return id.clone();
        }
    }
    string("")
}

/// `worldHopDistances(state, originNodeId)`: шаги графа от места
/// происшествия до узлов, не дальше [`MAX_RUMOR_HOPS`]; порядок — как у `Map` JS.
pub fn world_hop_distances(state: &Value, origin_node_id: Option<&Value>) -> IndexMap<String, i64> {
    let origin = text(origin_node_id, 180);
    let mut distances: IndexMap<String, i64> = IndexMap::new();
    if origin.is_empty() {
        return distances;
    }
    let mut adjacency: IndexMap<String, Vec<String>> = IndexMap::new();
    for route in array(get(get(Some(state), "worldMap"), "routes")) {
        let from = text(get(Some(route), "from"), 180);
        let to = text(get(Some(route), "to"), 180);
        if from.is_empty() || to.is_empty() {
            continue;
        }
        adjacency.entry(from.clone()).or_default().push(to.clone());
        adjacency.entry(to).or_default().push(from);
    }
    distances.insert(origin.clone(), 0);
    let mut frontier = vec![origin];
    let mut hop = 1;
    while hop <= MAX_RUMOR_HOPS && !frontier.is_empty() {
        let mut next: Vec<String> = Vec::new();
        for node in &frontier {
            let neighbours = sorted(adjacency.get(node).cloned().unwrap_or_default());
            for neighbour in neighbours {
                if distances.contains_key(&neighbour) {
                    continue;
                }
                distances.insert(neighbour.clone(), hop);
                next.push(neighbour);
            }
        }
        frontier = sorted(next);
        hop += 1;
    }
    distances
}

/// `distances.get(nodeId)`: ключи `Map` — строки, другое значение не находится.
fn distance_of(distances: &IndexMap<String, i64>, node_id: &Value) -> Option<i64> {
    match node_id {
        Value::String(key) => distances.get(key).copied(),
        _ => None,
    }
}

/// Где числится NPC: собственная локация, иначе текущая сцена.
fn npc_node_id_for(state: &Value, npc: &Value) -> Value {
    let own = world_node_id_for(state, get(Some(npc), "location"));
    if js::truthy(Some(&own)) {
        return own;
    }
    let by_scene = world_node_id_for(state, Some(&string(scene_location_id(state))));
    if js::truthy(Some(&by_scene)) {
        return by_scene;
    }
    world_node_id_for(state, get(get(Some(state), "scene"), "location"))
}

/// Кто способен услышать и пересказать: живые доступные NPC с id и именем.
fn living_npcs(state: &Value) -> Vec<Value> {
    let world = normalize_npc_world_state(get(Some(state), "npc_world"), &json!({}));
    let vitals = world.get("vitals");
    social_list(state, "npcs")
        .iter()
        .filter(|npc| {
            let npc = Some(*npc);
            js::truthy(get(npc, "id"))
                && js::truthy(get(npc, "name"))
                && !js::is_false(get(npc, "available"))
                && !js::is_false(get(get(vitals, &js::string(get(npc, "id"))), "alive"))
        })
        .cloned()
        .collect()
}

/// `rumorClaimId(deed, npcId)`.
pub fn rumor_claim_id(deed: Option<&Value>, npc_id: Option<&Value>) -> String {
    format!("rumor:{}", digest20(&[js::s(get(deed, "id")), js::s(npc_id)]))
}

fn rumor_claim_id_str(deed: &Value, npc_id: &str) -> String {
    format!("rumor:{}", digest20(&[js::s(deed.get("id")), npc_id.to_string()]))
}

/// `value || fallback` как строка замены (`replaceAll` приводит её `String()`).
fn truthy_text(value: Option<&Value>, fallback: &str) -> String {
    if js::truthy(value) {
        js::s(value)
    } else {
        fallback.to_string()
    }
}

/// `rumorWording(deed, hop)`: формулировка по дальности пересказа.
///
/// Вид — ключ `Object.prototype` (`constructor`, …) в JS роняет вызов
/// (`undefined.replaceAll`); здесь для него берутся запасные формулировки.
pub fn rumor_wording(deed: &Value, hop: Option<&Value>) -> String {
    let deed = Some(deed);
    let kind_name = js::string(get(deed, "kind"));
    let variants = RUMOR_PHRASES.iter().find(|(key, _)| *key == kind_name).map_or(&FALLBACK_RUMOR_PHRASES, |(_, phrases)| phrases);
    let index = integer(hop, 0).clamp(0, variants.len() as i64 - 1) as usize;
    let who = match get(deed, "actor_names") {
        Some(Value::Array(items)) => items.iter().map(|item| js::s(Some(item))).collect::<Vec<_>>().join(", "),
        _ => String::new(),
    };
    let who = if who.is_empty() { "чужаки".to_string() } else { who };
    let line = replace_all_literal(variants[index], "{place}", &truthy_text(get(deed, "location_name"), "дальних краях"));
    let line = replace_all_literal(&line, "{who}", &who);
    let line = replace_all_literal(&line, "{what}", &truthy_text(get(deed, "subject"), "что-то"));
    text_str(&line, 1_000)
}

fn world_minute(state: &Value, options: &Value) -> f64 {
    let raw = coalesce(get(Some(options), "worldMinute"), js::path(state, &["mechanics", "world_time", "elapsed_minutes"]));
    integer(raw, 0).max(0) as f64
}

fn claim_ids(list: Option<&Value>) -> HashSet<String> {
    array(list).iter().map(|entry| js::s(get(Some(entry), "id"))).collect()
}

fn origin_distances(state: &Value, deed: &Value) -> IndexMap<String, i64> {
    let by_id = world_node_id_for(state, deed.get("location_id"));
    let origin = if js::truthy(Some(&by_id)) { by_id } else { world_node_id_for(state, deed.get("location_name")) };
    world_hop_distances(state, Some(&origin))
}

/// `rumorSpreadTargets(state, { worldMinute })`: кому и когда слух дойдёт.
pub fn rumor_spread_targets(state: &Value, options: &Value) -> Vec<Value> {
    let minute = world_minute(state, options);
    let ledger = normalize_world_deeds_state(get(Some(state), "world_deeds"));
    let npcs = living_npcs(state);
    let existing = claim_ids(get(get(Some(state), "worldMemory"), "epistemic_claims"));
    let mut targets: Vec<(String, Value)> = Vec::new();
    for deed in deeds_of(&ledger) {
        if js::is_true(deed.get("secret")) {
            continue;
        }
        let spread_at = js::number(deed.get("spread_at_minutes"));
        if minute < spread_at {
            continue;
        }
        let witnesses: HashSet<String> = str_list(deed.get("witness_ids")).into_iter().collect();
        let distances = origin_distances(state, deed);
        for npc in &npcs {
            let npc_id = js::string(npc.get("id"));
            let node_id = npc_node_id_for(state, npc);
            let hop = if witnesses.contains(&npc_id) { Some(0) } else { distance_of(&distances, &node_id) };
            let Some(hop) = hop else { continue };
            if hop > MAX_RUMOR_HOPS {
                continue;
            }
            if minute < spread_at + (hop * RUMOR_HOP_MINUTES) as f64 {
                continue;
            }
            let claim_id = rumor_claim_id_str(deed, &npc_id);
            if existing.contains(&claim_id) {
                continue;
            }
            let claim = rumor_wording(deed, Some(&Value::from(hop)));
            let mut target = Map::new();
            target.insert("deed".into(), deed.clone());
            target.insert("npc".into(), npc.clone());
            target.insert("npc_id".into(), string(npc_id));
            target.insert("hop".into(), Value::from(hop));
            target.insert("claim_id".into(), string(claim_id.clone()));
            target.insert("claim".into(), string(claim));
            targets.push((claim_id, Value::Object(target)));
        }
    }
    targets.sort_by(|left, right| jstext::locale_compare(&left.0, &right.0));
    targets.into_iter().map(|(_, target)| target).collect()
}

fn deed_fact_id(deed: &Value) -> String {
    format!("fact:party-deed:{}", digest20(&[js::s(deed.get("id"))]))
}

fn location_entity_for(deed: &Value) -> Value {
    let location_id = js::s(deed.get("location_id"));
    let name = or_else(or_else(js::s(deed.get("location_name")), || location_id.clone()), || "Неизвестное место".to_string());
    let id_source = if location_id.is_empty() { name.clone() } else { location_id };
    json!({
        "id": format!("location-{}", digest20(&[id_source])),
        "kind": "location",
        "name": text_str(&name, 160),
        "summary": "",
        "aliases": [],
        "visibility": "gm_only",
        "tags": ["world-deeds"],
    })
}

/// `planWorldRumorTick(state, { worldMinute, limit })`: команды памяти мира
/// на один такт — факты поступков и новые слухи. Итог — `{ commands, targets }`.
pub fn plan_world_rumor_tick(state: &Value, options: &Value) -> Value {
    let memory = get(Some(state), "worldMemory");
    let existing_entities = claim_ids(get(memory, "entities"));
    let existing_facts = claim_ids(get(memory, "facts"));
    let mut commands: Vec<Value> = Vec::new();
    let mut upserted: HashSet<String> = HashSet::new();
    let ledger = normalize_world_deeds_state(get(Some(state), "world_deeds"));
    let limit = match get(Some(options), "limit") {
        None => 24,
        some => integer(some, 24),
    };
    let mut upsert = |commands: &mut Vec<Value>, entity: Value| {
        let id = js::s(entity.get("id"));
        if existing_entities.contains(&id) || !upserted.insert(id) {
            return;
        }
        commands.push(json!({ "command_type": "UpsertWorldEntity", "entity": entity }));
    };
    let maximum_facts = limit.clamp(1, 40) as usize;
    for deed in deeds_of(&ledger) {
        if commands.len() >= maximum_facts * 2 {
            break;
        }
        let fact_id = deed_fact_id(deed);
        if existing_facts.contains(&fact_id) {
            continue;
        }
        let entity = location_entity_for(deed);
        let subject_id = entity["id"].clone();
        upsert(&mut commands, entity);
        let object = json!({
            "deed_id": deed["id"],
            "kind": deed["kind"],
            "alignment": deed["alignment"],
            "severity": deed["severity"],
            "at_minutes": deed["at_minutes"],
            "witnesses": array(deed.get("witness_ids")).len(),
            "secret": deed["secret"],
        });
        commands.push(json!({ "command_type": "RecordWorldFact", "fact": {
            "id": fact_id,
            "subject_id": subject_id,
            "predicate": "party_deed",
            "object": jstext::slice(&js::stringify(&object), 0, Some(1_000)),
            "summary": deed["summary"],
            "visibility": "gm_only",
            "source_event_ids": deed["source_event_ids"],
        } }));
    }
    // `rumorSpreadTargets(state, { worldMinute })`: из параметров читается только минута.
    let mut targets = rumor_spread_targets(state, options);
    targets.truncate(limit.clamp(1, 60) as usize);
    for target in &targets {
        let npc = target.get("npc");
        let npc_id = target["npc_id"].clone();
        upsert(
            &mut commands,
            json!({
                "id": npc_id,
                "kind": "npc",
                "name": text(get(npc, "name"), 160),
                "summary": text(get(npc, "public_summary"), 1_000),
                "aliases": [],
                "visibility": "gm_only",
                "tags": [],
            }),
        );
        let deed = &target["deed"];
        let source_event_ids = deed["source_event_ids"].clone();
        commands.push(json!({ "command_type": "RecordRumor", "claim": {
            "id": target["claim_id"],
            "holder_entity_id": npc_id,
            "predicate": format!("party_deed:{}", js::s(deed.get("kind"))),
            "claim": target["claim"],
            "summary": target["claim"],
            "visibility": "gm_only",
            "source_event_ids": source_event_ids,
        } }));
        if target["hop"] == 0 && !array(Some(&source_event_ids)).is_empty() {
            commands.push(json!({
                "command_type": "ResolveEpistemicClaim",
                "claim_id": target["claim_id"],
                "truth_status": "confirmed",
                "source_event_ids": source_event_ids,
            }));
        }
    }
    json!({ "commands": commands, "targets": targets })
}

/// `rumorReputationDelta(deed, hop)`: поправка по тяжести и дальности. Ступень
/// — ключ `Object.prototype` даёт в JS `NaN`, и здесь тоже.
pub fn rumor_reputation_delta(deed: Option<&Value>, hop: Option<&Value>) -> f64 {
    let severity = js::string(get(deed, "severity"));
    let base = match DEED_REPUTATION_BASE.iter().find(|(key, _)| *key == severity) {
        Some((_, value)) => *value,
        None if is_prototype_key(&severity) => f64::NAN,
        None => 2.0,
    };
    let divisor = [1.0, 2.0, 4.0][integer(hop, 0).clamp(0, 2) as usize];
    let rounded = js::round(base / divisor);
    let magnitude = if rounded.is_nan() { f64::NAN } else { rounded.max(1.0) };
    if alignment_of(&js::string(get(deed, "kind"))) == "bright" {
        magnitude
    } else {
        -magnitude
    }
}

/// `planWorldRumorReputation(state)`: события `FactionReputationAdjusted` —
/// один раз на пару «поступок + фракция», по ближайшему держателю слуха.
pub fn plan_world_rumor_reputation(state: &Value) -> Vec<Value> {
    let ledger = normalize_world_deeds_state(get(Some(state), "world_deeds"));
    let mut npcs: IndexMap<String, Value> = IndexMap::new();
    for npc in living_npcs(state) {
        npcs.insert(js::string(npc.get("id")), npc);
    }
    let claims: Vec<&Value> = array(get(get(Some(state), "worldMemory"), "epistemic_claims"))
        .iter()
        .filter(|claim| js::s(get(Some(claim), "kind")) == "rumor")
        .collect();
    let mut events: Vec<Value> = Vec::new();
    for deed in deeds_of(&ledger) {
        let paid: HashSet<String> = str_list(deed.get("reputation_faction_ids")).into_iter().collect();
        let witnesses = str_list(deed.get("witness_ids"));
        let mut nearest: IndexMap<String, i64> = IndexMap::new();
        let distances = origin_distances(state, deed);
        for claim in &claims {
            let holder_id = js::s(get(Some(claim), "holder_entity_id"));
            let Some(npc) = npcs.get(&holder_id) else { continue };
            if js::s(get(Some(claim), "id")) != rumor_claim_id_str(deed, &holder_id) {
                continue;
            }
            let hop = if witnesses.contains(&holder_id) { 0 } else { distance_of(&distances, &npc_node_id_for(state, npc)).unwrap_or(MAX_RUMOR_HOPS) };
            for faction_id in faction_ids_for_npc(Some(npc)) {
                if paid.contains(&faction_id) {
                    continue;
                }
                match nearest.get_mut(&faction_id) {
                    Some(previous) if hop < *previous => *previous = hop,
                    Some(_) => {}
                    None => {
                        nearest.insert(faction_id, hop);
                    }
                }
            }
        }
        let mut entries: Vec<(String, i64)> = nearest.into_iter().collect();
        entries.sort_by(|left, right| jstext::locale_compare(&left.0, &right.0));
        for (faction_id, hop) in entries {
            events.push(json!({
                "event_type": "FactionReputationAdjusted",
                "payload": {
                    "faction_id": faction_id,
                    "delta": js::num(rumor_reputation_delta(Some(deed), Some(&Value::from(hop)))),
                    "deed_id": deed["id"],
                    "deed_kind": deed["kind"],
                    "source_event_id": array(deed.get("source_event_ids")).first().cloned().unwrap_or_else(|| string("")),
                    "provenance": { "source": "server-rumor-policy", "policy": WORLD_RUMOR_POLICY_ID },
                },
                "target_ids": [],
                "visibility": "gm_only",
            }));
        }
    }
    events
}

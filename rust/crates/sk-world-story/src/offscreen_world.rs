//! Перенос `server/offscreen-world.mjs`: «Пока вас не было…» — мир живёт,
//! когда отряд спит.
//!
//! Ход мира считается на существенном скачке времени (от восьми часов) и не
//! чаще раза в игровые сутки: часы party-видимых заданий (до последнего
//! деления, но не до развязки), протухание просроченного через сутки
//! наблюдения, ход фракции-антагониста из закрытого набора (посты, лагерь,
//! заложник из известных NPC) и счёт молвы. Своих тиков, костей и часов
//! реального мира нет: выбор — sha256 от подписи и остаток от деления, поэтому
//! replay воспроизводит ход мира по построению.
//!
//! Видимость: в ход мира попадают только party-видимые задания, фракции и NPC
//! (`visible_to_party` в трёх местах) — лента уезжает игроку той же проекцией,
//! что и ведущему.

use serde_json::{json, Map, Value};
use sk_core::{hash, js, re, text as jstext};
use sk_npc_world::npc_positioning::{normalize_npc_world_state, present_scene_npcs};
use sk_world_time::weather::{campaign_day_of, campaign_seed_of};
use sk_world_time::world_deeds::rumor_spread_targets;

use crate::support::{array, head_utf16, is_str, path, prop};

pub const OFFSCREEN_WORLD_SCHEMA_VERSION: i64 = 1;
pub const OFFSCREEN_WORLD_POLICY_ID: &str = "skazanie:offscreen-world-v1";
pub const OFFSCREEN_WORLD_EVENT_TYPE: &str = "OffscreenWorldStepResolved";
/// Заголовок карточки летописи и сводки памяти мира — один на оба места. В
/// памяти мира он ложится в NFKC-форме (`…` → `...`), искать его по началу.
pub const OFFSCREEN_CARD_TITLE: &str = "Пока вас не было…";
/// Начало заголовка без завершающего многоточия: им сводка и опознаётся.
pub const OFFSCREEN_CARD_TITLE_PREFIX: &str = "Пока вас не было";

/// Существенный скачок: продолжительный отдых и всё, что дольше.
pub const OFFSCREEN_STEP_MINIMUM_MINUTES: i64 = 480;
/// Мир ходит не чаще раза в игровые сутки.
pub const OFFSCREEN_STEP_INTERVAL_MINUTES: i64 = 1_440;
/// Сколько игрового времени просроченное задание держится под наблюдением.
pub const OFFSCREEN_QUEST_EXPIRY_MINUTES: i64 = 1_440;
/// Сколько заданий двигает один ход мира.
pub const OFFSCREEN_QUEST_TICK_LIMIT: usize = 4;

const MAX_STEPS: usize = 40;
const MAX_ENTRIES: usize = 12;
const MAX_LINES: usize = 3;
const MAX_WATCH: usize = 16;
const MAX_DEADLINE_ENTRIES: usize = 3;
const MAX_EXPIRED_ENTRIES: usize = 2;

/// Закрытый набор ходов фракции-антагониста.
pub const FACTION_MOVE_KINDS: [&str; 3] = ["reinforced_posts", "moved_camp", "took_hostage"];

/// Русские подписи записей ленты (`OFFSCREEN_ENTRY_LABELS`).
pub const OFFSCREEN_ENTRY_LABELS: [(&str, &str); 5] = [
    ("quest_clock", "Часы задания"),
    ("quest_deadline", "Срок на исходе"),
    ("quest_expired", "Задание провалено"),
    ("faction_move", "Ход противника"),
    ("rumor_spread", "Молва"),
];

fn entry_label(kind: &str) -> Option<&'static str> {
    OFFSCREEN_ENTRY_LABELS.iter().find(|(id, _)| *id == kind).map(|(_, label)| *label)
}

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, max)`.
fn text(value: Option<&Value>, max: usize) -> String {
    head_utf16(&jstext::squash_spaces(&jstext::nfkc(&js::s(value))), max)
}

/// `Number.isSafeInteger(Number(value)) ? Number(value) : fallback`.
fn integer(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 {
        number
    } else {
        fallback
    }
}

/// `integer` для числа, уже посчитанного в f64.
fn integer_f64(number: f64, fallback: f64) -> f64 {
    integer(Some(&js::num(number)), fallback)
}

fn digest(parts: &[String]) -> String {
    hash::sha256_hex(parts.join("\0"))
}

fn num_text(value: f64) -> String {
    js::f64_string(value)
}

fn world_minutes(state: &Value) -> f64 {
    integer(path(Some(state), &["mechanics", "world_time", "elapsed_minutes"]), 0.0).max(0.0)
}

fn day_of(minutes: f64) -> f64 {
    campaign_day_of(integer_f64(minutes, 0.0).max(0.0)) as f64 + 1.0
}

/// `offscreenCampaignDay(minutes)`: номер игрового дня — тот же счёт, что у неба.
pub fn offscreen_campaign_day(minutes: Option<&Value>) -> f64 {
    campaign_day_of(integer(minutes, 0.0).max(0.0)) as f64 + 1.0
}

// ---------------------------------------------------------------------------
// Состояние

fn safe_entry(value: Option<&Value>) -> Option<Value> {
    let field = |key: &str| prop(value, key);
    let kind = text(field("kind"), 40);
    entry_label(&kind)?;
    let move_kind = text(field("move_kind"), 40);
    Some(json!({
        "kind": kind,
        "summary": text(field("summary"), 400),
        "quest_id": text(field("quest_id"), 120),
        "quest_title": text(field("quest_title"), 180),
        "faction_id": text(field("faction_id"), 120),
        "faction_name": text(field("faction_name"), 180),
        "move_kind": if FACTION_MOVE_KINDS.contains(&move_kind.as_str()) { move_kind } else { String::new() },
        "npc_id": text(field("npc_id"), 120),
        "npc_name": text(field("npc_name"), 180),
        "count": js::num(integer(field("count"), 0.0).max(0.0)),
    }))
}

fn safe_step(value: Option<&Value>) -> Option<Value> {
    let field = |key: &str| prop(value, key);
    let id = text(field("id"), 140);
    if !jstext::test(re!(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,139}$", "u"), &id) {
        return None;
    }
    let mut entries: Vec<Value> = array(field("entries")).iter().filter_map(|raw| safe_entry(Some(raw))).collect();
    if entries.is_empty() {
        return None;
    }
    entries.truncate(MAX_ENTRIES);
    let at_minutes = integer(field("at_minutes"), 0.0).max(0.0);
    let lines: Vec<String> = array(field("lines")).iter().map(|line| text(Some(line), 400)).filter(|line| !line.is_empty()).take(MAX_LINES).collect();
    Some(json!({
        "id": id,
        "at_minutes": js::num(at_minutes),
        "elapsed_minutes": js::num(integer(field("elapsed_minutes"), 0.0).max(0.0)),
        "day": js::num(integer(field("day"), day_of(at_minutes)).max(1.0)),
        "entries": entries,
        "lines": lines,
        "policy_id": OFFSCREEN_WORLD_POLICY_ID,
    }))
}

fn safe_watch(value: Option<&Value>) -> Option<Value> {
    let quest_id = text(prop(value, "quest_id"), 120);
    if quest_id.is_empty() {
        return None;
    }
    Some(json!({ "quest_id": quest_id, "since_minutes": js::num(integer(prop(value, "since_minutes"), 0.0).max(0.0)) }))
}

fn tail(mut list: Vec<Value>, limit: usize) -> Vec<Value> {
    if list.len() > limit {
        list.drain(..list.len() - limit);
    }
    list
}

/// `normalizeOffscreenWorldState(input = {})`.
pub fn normalize_offscreen_world_state(input: Option<&Value>) -> Value {
    let source = input.filter(|value| value.is_object());
    let mut steps = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for raw in array(prop(source, "steps")) {
        let Some(step) = safe_step(Some(raw)) else { continue };
        let id = js::s(step.get("id"));
        if seen.contains(&id) {
            continue;
        }
        seen.push(id);
        steps.push(step);
    }
    let mut watch = Vec::new();
    let mut watched: Vec<String> = Vec::new();
    for raw in array(prop(source, "watch")) {
        let Some(entry) = safe_watch(Some(raw)) else { continue };
        let id = js::s(entry.get("quest_id"));
        if watched.contains(&id) {
            continue;
        }
        watched.push(id);
        watch.push(entry);
    }
    json!({ "schema_version": OFFSCREEN_WORLD_SCHEMA_VERSION, "steps": tail(steps, MAX_STEPS), "watch": tail(watch, MAX_WATCH) })
}

// ---------------------------------------------------------------------------
// Кто участвует в ходе мира

fn visible_to_party(value: Option<&Value>) -> bool {
    let visibility = text(value, 30);
    matches!(if visibility.is_empty() { "gm_only" } else { visibility.as_str() }, "party" | "public")
}

fn id_text(value: &Value) -> String {
    js::string(value.get("id"))
}

fn sort_by_id(list: &mut [&Value]) {
    list.sort_by(|left, right| jstext::locale_compare(&id_text(left), &id_text(right)));
}

/// Задания хода мира: только party-видимые и активные, по id.
fn party_quests(state: &Value) -> Vec<&Value> {
    let mut quests: Vec<&Value> = array(path(Some(state), &["worldMemory", "quests"]))
        .iter()
        .filter(|quest| js::truthy(prop(Some(quest), "id")) && is_str(quest.get("status"), "active") && visible_to_party(quest.get("visibility")))
        .collect();
    sort_by_id(&mut quests);
    quests
}

struct QuestClock {
    current: f64,
    max: f64,
    triggered: bool,
}

fn quest_clock_of(quest: &Value) -> QuestClock {
    let clock = quest.get("clock");
    let max = integer(prop(clock, "max"), 4.0).max(1.0);
    let current = integer(prop(clock, "current"), 0.0).min(max).max(0.0);
    QuestClock { current, max, triggered: js::is_true(prop(clock, "triggered")) || current >= max }
}

/// `antagonistFactionFor(state)`: фракция-антагонист — сначала помеченная
/// автором (`antagonist`, `enemy`, `hostile`), потом та, чья слава об отряде
/// хуже всех и строго ниже нуля. `None` — противника нет.
pub fn antagonist_faction_for(state: &Value) -> Option<&Value> {
    let factions: Vec<&Value> = array(path(Some(state), &["worldMemory", "entities"]))
        .iter()
        .filter(|entity| js::truthy(prop(Some(entity), "id")) && is_str(entity.get("kind"), "faction") && visible_to_party(entity.get("visibility")))
        .collect();
    let mut tagged: Vec<&Value> = factions
        .iter()
        .copied()
        .filter(|entity| array(entity.get("tags")).iter().any(|tag| matches!(text(Some(tag), 60).as_str(), "antagonist" | "enemy" | "hostile")))
        .collect();
    sort_by_id(&mut tagged);
    if let Some(first) = tagged.first() {
        return Some(first);
    }
    let reputations = path(Some(state), &["autonomy", "reputations"]).filter(|value| value.is_object() || value.is_array());
    let mut scored: Vec<(&Value, f64)> = factions
        .iter()
        .map(|entity| (*entity, integer(reputations.and_then(|map| map.get(id_text(entity).as_str())), 0.0)))
        .filter(|(_, score)| *score < 0.0)
        .collect();
    scored.sort_by(|left, right| {
        left.1.partial_cmp(&right.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| jstext::locale_compare(&id_text(left.0), &id_text(right.0)))
    });
    scored.first().map(|(entity, _)| *entity)
}

/// Кого фракция может увести: известный отряду живой NPC не из текущей сцены
/// и не торговец.
fn hostage_candidates<'a>(state: &'a Value, taken: &[String]) -> Vec<&'a Value> {
    let world = normalize_npc_world_state(state.get("npc_world"), &json!({}));
    let vitals = world.get("vitals");
    let present: Vec<String> = present_scene_npcs(state).iter().map(|npc| js::string(npc.get("id"))).collect();
    let merchants: Vec<String> = array(state.get("merchants")).iter().map(|merchant| js::s(prop(Some(merchant), "id"))).collect();
    let mut list: Vec<&Value> = array(path(Some(state), &["social", "npcs"]))
        .iter()
        .filter(|npc| js::truthy(prop(Some(npc), "id")) && js::truthy(prop(Some(npc), "name")))
        .filter(|npc| visible_to_party(npc.get("visibility")))
        .filter(|npc| !js::is_false(npc.get("available")) && !js::is_false(path(vitals, &[id_text(npc).as_str(), "alive"])))
        .filter(|npc| {
            let id = id_text(npc);
            !present.contains(&id) && !taken.contains(&id) && !merchants.contains(&id)
        })
        .collect();
    sort_by_id(&mut list);
    list
}

fn place_name_for(state: &Value) -> String {
    let scene = state.get("scene");
    let location = prop(scene, "location");
    text(if js::present(location) { location } else { prop(scene, "title") }, 180)
}

fn faction_move_variants(move_kind: &str, faction: &str, place: &str, npc: &str) -> Vec<String> {
    let with_place = |near: String, without: String| if place.is_empty() { without } else { near };
    match move_kind {
        "reinforced_posts" => vec![
            with_place(format!("{faction} усилила посты у «{place}»: чужаков теперь считают на подходе."), format!("{faction} усилила посты: чужаков теперь считают на подходе.")),
            with_place(
                format!("{faction} выставила дозоры вокруг «{place}»: незамеченным больше не пройти."),
                format!("{faction} выставила дозоры: незамеченным больше не пройти."),
            ),
            with_place(
                format!("{faction} сменила караулы близ «{place}»: на тракте стало людно и недобро."),
                format!("{faction} сменила караулы: на трактах стало людно и недобро."),
            ),
        ],
        "moved_camp" => vec![
            with_place(
                format!("{faction} снялась со стоянки близ «{place}» и встала там, где её не ждут."),
                format!("{faction} снялась со стоянки и встала там, где её не ждут."),
            ),
            with_place(
                format!("{faction} свернула лагерь под «{place}»: кострище остыло, а куда ушли — не сказали."),
                format!("{faction} свернула лагерь: кострище остыло, а куда ушли — не сказали."),
            ),
            with_place(
                format!("{faction} бросила старое место у «{place}» и залегла в стороне от дорог."),
                format!("{faction} бросила старое место и залегла в стороне от дорог."),
            ),
        ],
        _ => vec![
            format!("{faction} увела заложника: {npc} больше не выходит к людям."),
            format!("{faction} забрала с собой {npc}: с тех пор к людям больше не выходит."),
        ],
    }
}

fn hex_prefix(hex: &str, from: usize, to: usize) -> u64 {
    u64::from_str_radix(&hex[from..to], 16).unwrap_or(0)
}

/// Формулировка хода — по кругу от точки, заданной сидом кампании.
fn faction_move_summary(move_kind: &str, seed: &str, faction_id: &str, already_moved: usize, faction: &str, place: &str, npc: &str) -> String {
    let variants = faction_move_variants(move_kind, faction, place, npc);
    let start = hex_prefix(&digest(&[seed.into(), faction_id.into(), move_kind.into()]), 8, 16) as usize % variants.len();
    variants[(start + already_moved) % variants.len()].clone()
}

struct FactionPlan<'a> {
    entry: Map<String, Value>,
    hostage: Option<&'a Value>,
}

fn plan_faction_move<'a>(state: &'a Value, faction: &Value, at_minutes: f64, taken: &[String], moves_by_kind: &[(String, usize)]) -> Option<FactionPlan<'a>> {
    let seed = campaign_seed_of(state);
    let faction_id = text(faction.get("id"), 120);
    let start = hex_prefix(&digest(&[seed.clone(), js::s(faction.get("id")), num_text(at_minutes)]), 0, 8) as usize % FACTION_MOVE_KINDS.len();
    let place = place_name_for(state);
    let faction_name = text(faction.get("name"), 180);
    let faction_name = if faction_name.is_empty() { "Противник".to_string() } else { faction_name };
    for offset in 0..FACTION_MOVE_KINDS.len() {
        let move_kind = FACTION_MOVE_KINDS[(start + offset) % FACTION_MOVE_KINDS.len()];
        let already = moves_by_kind.iter().find(|(kind, _)| kind == move_kind).map_or(0, |(_, count)| *count);
        let mut entry = Map::new();
        entry.insert("kind".into(), json!("faction_move"));
        entry.insert("move_kind".into(), json!(move_kind));
        entry.insert("faction_id".into(), json!(faction_id));
        entry.insert("faction_name".into(), json!(faction_name));
        if move_kind != "took_hostage" {
            entry.insert("summary".into(), json!(faction_move_summary(move_kind, &seed, &faction_id, already, &faction_name, &place, "")));
            return Some(FactionPlan { entry, hostage: None });
        }
        let Some(hostage) = hostage_candidates(state, taken).first().copied() else { continue };
        let hostage_name = text(hostage.get("name"), 180);
        entry.insert("npc_id".into(), json!(text(hostage.get("id"), 120)));
        entry.insert("npc_name".into(), json!(hostage_name));
        entry.insert("summary".into(), json!(faction_move_summary(move_kind, &seed, &faction_id, already, &faction_name, "", &hostage_name)));
        return Some(FactionPlan { entry, hostage: Some(hostage) });
    }
    None
}

/// `{ ...value, available: false }` для записи расписания любого вида: строка
/// раскладывается по знакам, примитив и `null` не дают полей.
fn spread_unavailable(entry: &Value) -> Value {
    let mut map = match entry {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Value::String(text) => text.encode_utf16().enumerate().map(|(index, unit)| (index.to_string(), json!(String::from_utf16_lossy(&[unit])))).collect(),
        _ => Map::new(),
    };
    map.insert("available".into(), Value::Bool(false));
    Value::Object(map)
}

/// Уведённый NPC перестаёт быть доступным; расписание гасится вместе с профилем.
fn hostage_unavailable_draft(hostage: &Value) -> Value {
    let mut npc = hostage.as_object().cloned().unwrap_or_default();
    npc.insert("available".into(), Value::Bool(false));
    let schedule: Vec<Value> = array(hostage.get("schedule")).iter().map(spread_unavailable).collect();
    npc.insert("schedule".into(), Value::Array(schedule));
    // `dossier: undefined` — ключ из JSON уходит.
    npc.shift_remove("dossier");
    json!({
        "event_type": "NpcSocialProfileUpserted",
        "visibility": "party",
        "payload": { "npc": npc },
        "target_ids": [text(hostage.get("id"), 120)],
    })
}

fn ledger_entries(ledger: &Value) -> impl Iterator<Item = &Value> {
    array(ledger.get("steps")).iter().flat_map(|step| array(step.get("entries")).iter())
}

fn hostages_taken(ledger: &Value) -> Vec<String> {
    let mut taken: Vec<String> = Vec::new();
    for entry in ledger_entries(ledger) {
        if is_str(entry.get("kind"), "faction_move") && is_str(entry.get("move_kind"), "took_hostage") && js::truthy(entry.get("npc_id")) {
            let id = js::s(entry.get("npc_id"));
            if !taken.contains(&id) {
                taken.push(id);
            }
        }
    }
    taken
}

fn faction_moves_by_kind(ledger: &Value) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = FACTION_MOVE_KINDS.iter().map(|kind| (kind.to_string(), 0)).collect();
    for entry in ledger_entries(ledger) {
        if !is_str(entry.get("kind"), "faction_move") {
            continue;
        }
        let move_kind = js::s(entry.get("move_kind"));
        if let Some(count) = counts.iter_mut().find(|(kind, _)| *kind == move_kind) {
            count.1 += 1;
        }
    }
    counts
}

// ---------------------------------------------------------------------------
// Ход мира

fn quest_label(quest: &Value) -> String {
    let title = text(quest.get("title"), 180);
    if !title.is_empty() {
        return title;
    }
    let id = text(quest.get("id"), 120);
    if id.is_empty() {
        "задание".into()
    } else {
        id
    }
}

/// Короткое имя задания для врезки: до двоеточия и не длиннее семидесяти
/// знаков (единиц UTF-16) по границе слова.
fn short_quest_title(title: Option<&Value>) -> String {
    let source = js::s(title);
    let head = re!(r":\s", "u").split(&source).next().and_then(Result::ok).unwrap_or("");
    let head = jstext::replace_first(re!(r"[.!?…\s]+$", "u"), head, "");
    let head = jstext::trim(&head).to_string();
    let units: Vec<u16> = head.encode_utf16().collect();
    if units.len() <= 70 {
        return head;
    }
    let cut = &units[..70];
    let last_space = cut.iter().rposition(|unit| *unit == u16::from(b' ')).map_or(-1, |index| index as i64);
    let keep = last_space.max(40) as usize;
    let kept = String::from_utf16_lossy(&cut[..keep]);
    format!("{}…", jstext::replace_first(re!(r"[,;—–-]+$", "u"), &kept, ""))
}

fn world_fact_draft(id: String, subject_id: &str, predicate: String, object: Value, summary: &str, at_minutes: f64) -> Value {
    json!({
        "event_type": "WorldFactRecorded",
        "visibility": "party",
        "payload": {
            "fact": {
                "id": id,
                "subject_id": subject_id,
                "predicate": predicate,
                "object": head_utf16(&js::stringify(&object), 1_000),
                "summary": summary,
                "visibility": "party",
                "source_event_ids": [],
                "source_command_id": "",
                "supersedes_fact_id": "",
                "status": "active",
                "recorded_at_minutes": js::num(at_minutes),
            },
        },
        "target_ids": [],
    })
}

/// `planOffscreenWorldStep(state, { elapsedMinutes })`: ход мира за один
/// скачок времени — `{ step, drafts }` или `None`. Чистая функция.
pub fn plan_offscreen_world_step(state: &Value, elapsed_minutes: Option<&Value>) -> Option<Value> {
    let jump = integer(elapsed_minutes, 0.0).max(0.0);
    if jump < OFFSCREEN_STEP_MINIMUM_MINUTES as f64 {
        return None;
    }
    let at_minutes = world_minutes(state) + jump;
    let ledger = normalize_offscreen_world_state(state.get("offscreen_world"));
    if let Some(previous) = array(ledger.get("steps")).last() {
        if at_minutes - js::number(previous.get("at_minutes")) < OFFSCREEN_STEP_INTERVAL_MINUTES as f64 {
            return None;
        }
    }
    let quests = party_quests(state);
    let watched_since: Vec<(String, f64)> =
        array(ledger.get("watch")).iter().map(|entry| (js::s(entry.get("quest_id")), js::number(entry.get("since_minutes")))).collect();
    let since_of = |id: &str| watched_since.iter().find(|(quest, _)| quest == id).map(|(_, since)| *since);
    let mut entries: Vec<Value> = Vec::new();
    let mut drafts: Vec<Value> = Vec::new();

    // 1. Просроченное.
    let expired: Vec<&Value> = quests
        .iter()
        .copied()
        .filter(|quest| quest_clock_of(quest).triggered)
        .filter(|quest| since_of(&id_text(quest)).is_some_and(|since| at_minutes - since >= OFFSCREEN_QUEST_EXPIRY_MINUTES as f64))
        .take(MAX_EXPIRED_ENTRIES)
        .collect();
    for quest in &expired {
        let title = quest_label(quest);
        let quest_id = text(quest.get("id"), 120);
        let summary = format!("«{title}»: срок вышел, помощи так и не дождались.");
        entries.push(json!({ "kind": "quest_expired", "quest_id": quest_id, "quest_title": title, "summary": summary }));
        drafts.push(json!({
            "event_type": "QuestResolved",
            "visibility": "party",
            "payload": {
                "quest_id": quest_id,
                "outcome": "failure",
                "status": "failed",
                "summary": summary,
                "next_objective": "Разобраться, чем обернулся упущенный срок.",
                "source_event_ids": [],
                "policy_id": OFFSCREEN_WORLD_POLICY_ID,
            },
            "target_ids": [],
        }));
        let entity_id = format!("offscreen-quest-{}", &digest(&[quest_id.clone()])[..20]);
        drafts.push(json!({
            "event_type": "WorldEntityUpserted",
            "visibility": "party",
            "payload": {
                "entity": {
                    "id": entity_id,
                    "kind": "event",
                    "name": title,
                    "summary": text(quest.get("summary"), 1_000),
                    "aliases": [],
                    "visibility": "party",
                    "tags": ["offscreen-world"],
                },
            },
            "target_ids": [],
        }));
        drafts.push(world_fact_draft(
            format!("fact:offscreen-quest-expired:{}", &digest(&[quest_id.clone(), num_text(at_minutes)])[..20]),
            &entity_id,
            "quest_deadline_missed".into(),
            json!({ "quest_id": quest_id, "at_minutes": js::num(at_minutes) }),
            &summary,
            at_minutes,
        ));
    }
    let expired_ids: Vec<String> = expired.iter().map(|quest| id_text(quest)).collect();

    // 2. Часы.
    let ticking: Vec<&Value> = quests
        .iter()
        .copied()
        .filter(|quest| !expired_ids.contains(&id_text(quest)))
        .filter(|quest| {
            let clock = quest_clock_of(quest);
            !clock.triggered && clock.current + 1.0 < clock.max
        })
        .take(OFFSCREEN_QUEST_TICK_LIMIT)
        .collect();
    for quest in &ticking {
        let clock = quest_clock_of(quest);
        let title = quest_label(quest);
        let quest_id = text(quest.get("id"), 120);
        let summary = format!("«{}» — времени на это остаётся меньше.", short_quest_title(Some(&json!(title))));
        entries.push(json!({ "kind": "quest_clock", "quest_id": quest_id, "quest_title": title, "count": js::num(clock.current + 1.0), "summary": summary }));
        drafts.push(json!({
            "event_type": "QuestClockAdvanced",
            "visibility": "party",
            "payload": { "quest_id": quest_id, "amount": 1, "policy_id": OFFSCREEN_WORLD_POLICY_ID },
            "target_ids": [],
        }));
    }

    // 3. Наблюдение.
    let mut watch_after: Vec<Value> = Vec::new();
    for (quest_id, since) in &watched_since {
        if expired_ids.contains(quest_id) {
            continue;
        }
        let Some(quest) = quests.iter().find(|quest| id_text(quest) == *quest_id) else { continue };
        if !quest_clock_of(quest).triggered {
            continue;
        }
        watch_after.push(json!({ "quest_id": quest_id, "since_minutes": js::num(*since) }));
    }
    let mut announced = 0;
    for quest in &quests {
        let quest_id = id_text(quest);
        if expired_ids.contains(&quest_id) || since_of(&quest_id).is_some() {
            continue;
        }
        if !quest_clock_of(quest).triggered {
            continue;
        }
        watch_after.push(json!({ "quest_id": quest_id, "since_minutes": js::num(at_minutes) }));
        if announced >= MAX_DEADLINE_ENTRIES {
            continue;
        }
        announced += 1;
        let label = quest_label(quest);
        entries.push(json!({
            "kind": "quest_deadline",
            "quest_id": text(quest.get("id"), 120),
            "quest_title": label,
            "summary": format!("«{label}»: часы заполнены, счёт пошёл на сутки."),
        }));
    }

    // 4. Ход фракции-антагониста.
    let plan = antagonist_faction_for(state)
        .and_then(|faction| plan_faction_move(state, faction, at_minutes, &hostages_taken(&ledger), &faction_moves_by_kind(&ledger)));
    if let Some(plan) = plan {
        let entry = plan.entry;
        if let Some(hostage) = plan.hostage {
            drafts.push(hostage_unavailable_draft(hostage));
        }
        let entity_id = text(entry.get("faction_id"), 120);
        let move_kind = js::s(entry.get("move_kind"));
        let summary = js::s(entry.get("summary"));
        drafts.push(world_fact_draft(
            format!("fact:offscreen-faction:{}", &digest(&[entity_id.clone(), move_kind.clone(), num_text(at_minutes)])[..20]),
            &entity_id,
            format!("faction_offscreen_move:{move_kind}"),
            json!({ "faction_id": entity_id, "move_kind": move_kind, "npc_id": entry.get("npc_id").cloned().unwrap_or(json!("")), "at_minutes": js::num(at_minutes) }),
            &summary,
            at_minutes,
        ));
        entries.push(Value::Object(entry));
    }

    // 5. Молва.
    let rumors = rumor_spread_targets(state, &json!({ "worldMinute": js::num(at_minutes) })).len();
    if rumors > 0 {
        let summary = if rumors == 1 {
            "Молва о делах отряда доходит ещё до одного человека.".to_string()
        } else {
            format!("Молва о делах отряда расходится дальше: её пересказывают ещё {rumors} раз.")
        };
        entries.push(json!({ "kind": "rumor_spread", "count": rumors, "summary": summary }));
    }

    if entries.is_empty() {
        return None;
    }
    let bounded: Vec<Value> = entries.iter().take(MAX_ENTRIES).filter_map(|entry| safe_entry(Some(entry))).collect();
    let lines = offscreen_lines_for(Some(&Value::Array(bounded.clone())));
    let step = safe_step(Some(&json!({
        "id": format!("offscreen:{}", &digest(&[campaign_seed_of(state), num_text(at_minutes), num_text(jump)])[..24]),
        "at_minutes": js::num(at_minutes),
        "elapsed_minutes": js::num(jump),
        "day": js::num(day_of(at_minutes)),
        "entries": bounded,
        "lines": lines,
    })))?;
    let step_id = js::s(step.get("id"));
    drafts.push(json!({
        "event_type": OFFSCREEN_WORLD_EVENT_TYPE,
        "visibility": "party",
        "payload": {
            "schema_version": OFFSCREEN_WORLD_SCHEMA_VERSION,
            "policy_id": OFFSCREEN_WORLD_POLICY_ID,
            "step": step,
            "watch_after": tail(watch_after, MAX_WATCH),
        },
        "target_ids": [],
    }));
    drafts.push(json!({
        "event_type": "NarrativeSummaryRecorded",
        "visibility": "party",
        "payload": {
            "summary": {
                "id": format!("summary:{step_id}"),
                "kind": "scene",
                "title": OFFSCREEN_CARD_TITLE,
                "summary": lines.join(" "),
                "visibility": "party",
                "entity_ids": [],
                "thread_ids": [],
                "source_event_ids": [],
                "source_command_id": "",
                "recorded_at_minutes": js::num(at_minutes),
            },
        },
        "target_ids": [],
    }));
    Some(json!({ "step": step, "drafts": drafts }))
}

/// Порядок строк карточки — порядок важности за столом.
const LINE_PRIORITY: [&str; 5] = ["quest_expired", "faction_move", "quest_deadline", "quest_clock", "rumor_spread"];

/// `offscreenLinesFor(entries)`: строки карточки, не больше трёх; тиканье
/// часов — одна строка на всю врезку.
pub fn offscreen_lines_for(entries: Option<&Value>) -> Vec<String> {
    let list = array(entries);
    let kind_of = |entry: &Value| prop(Some(entry), "kind").cloned();
    let clocks: Vec<&Value> = list.iter().filter(|entry| is_str(kind_of(entry).as_ref(), "quest_clock")).collect();
    let mut lines = Vec::new();
    for kind in LINE_PRIORITY {
        if kind == "quest_clock" {
            if !clocks.is_empty() {
                lines.push(quest_clock_line(&clocks));
            }
            continue;
        }
        for entry in list.iter().filter(|entry| is_str(kind_of(entry).as_ref(), kind)) {
            lines.push(text(prop(Some(entry), "summary"), 400));
        }
    }
    lines.into_iter().filter(|line| !line.is_empty()).take(MAX_LINES).collect()
}

fn quest_clock_line(clocks: &[&Value]) -> String {
    let first = clocks.first().copied();
    if clocks.len() == 1 {
        return text(prop(first, "summary"), 400);
    }
    format!("Время не ждёт: «{}» и другие дела отряда без вас не стоят на месте.", short_quest_title(prop(first, "quest_title")))
}

// ---------------------------------------------------------------------------
// Редьюсер и ленты

/// `applyOffscreenWorldEvent(input, event)`: свёртка события в реестр.
/// Уже нормализованный реестр (`schema_version` и массив `steps`) JS берёт
/// как есть, без нормализации, — так и здесь.
pub fn apply_offscreen_world_event(input: Option<&Value>, event: Option<&Value>) -> Value {
    let raw = input.filter(|input| {
        js::number(prop(Some(input), "schema_version")) == OFFSCREEN_WORLD_SCHEMA_VERSION as f64
            && matches!(prop(Some(input), "schema_version"), Some(Value::Number(_)))
            && matches!(prop(Some(input), "steps"), Some(Value::Array(_)))
    });
    let normalized = raw.cloned().unwrap_or_else(|| normalize_offscreen_world_state(input));
    if js::s(prop(event, "event_type")) != OFFSCREEN_WORLD_EVENT_TYPE {
        return normalized;
    }
    let payload = prop(event, "payload");
    let Some(step) = safe_step(prop(payload, "step")) else { return normalized };
    let steps = array(normalized.get("steps"));
    if steps.iter().any(|entry| prop(Some(entry), "id") == step.get("id")) {
        return normalized;
    }
    let mut next = normalized.as_object().cloned().unwrap_or_default();
    let mut list = steps.to_vec();
    list.push(step);
    next.insert("steps".into(), Value::Array(list));
    let watch = match prop(payload, "watch_after") {
        Some(Value::Array(items)) => Value::Array(items.clone()),
        _ => normalized.get("watch").cloned().unwrap_or(Value::Null),
    };
    if watch.is_null() && !normalized.as_object().is_some_and(|map| map.contains_key("watch")) {
        next.shift_remove("watch");
    } else {
        next.insert("watch".into(), watch);
    }
    normalize_offscreen_world_state(Some(&Value::Object(next)))
}

/// `offscreenWorldFeed(state, { limit })`: лента ведущего — свежие ходы
/// сверху, подписи проставлены. `limit` — `None` для значения по умолчанию.
pub fn offscreen_world_feed(state: &Value, limit: Option<&Value>) -> Vec<Value> {
    let ledger = normalize_offscreen_world_state(state.get("offscreen_world"));
    let mut steps: Vec<Value> = array(ledger.get("steps")).to_vec();
    steps.sort_by(|left, right| {
        let (a, b) = (js::number(left.get("at_minutes")), js::number(right.get("at_minutes")));
        b.partial_cmp(&a).unwrap_or(std::cmp::Ordering::Equal).then_with(|| jstext::locale_compare(&js::s(left.get("id")), &js::s(right.get("id"))))
    });
    let limit = match limit {
        None => 20.0,
        Some(value) => integer(Some(value), 20.0),
    };
    let take = limit.min(MAX_STEPS as f64).max(1.0) as usize;
    steps
        .into_iter()
        .take(take)
        .map(|mut step| {
            let entries: Vec<Value> = array(step.get("entries"))
                .iter()
                .map(|entry| {
                    let mut entry = entry.as_object().cloned().unwrap_or_default();
                    let kind = js::s(entry.get("kind"));
                    entry.insert("label".into(), json!(entry_label(&kind).map_or(kind.clone(), str::to_string)));
                    Value::Object(entry)
                })
                .collect();
            if let Some(map) = step.as_object_mut() {
                map.insert("entries".into(), Value::Array(entries));
            }
            step
        })
        .collect()
}

/// `offscreenChronicleEntry(event)`: карточка летописи из подтверждённого события.
pub fn offscreen_chronicle_entry(event: Option<&Value>) -> Option<Value> {
    if js::s(prop(event, "event_type")) != OFFSCREEN_WORLD_EVENT_TYPE {
        return None;
    }
    let step = safe_step(path(event, &["payload", "step"]))?;
    let lines = array(step.get("lines"));
    if lines.is_empty() {
        return None;
    }
    let text: Vec<String> = lines.iter().map(|line| js::s(Some(line))).collect();
    Some(json!({
        "id": format!("chronicle:{}", js::s(step.get("id"))),
        "speaker": "system",
        "author": OFFSCREEN_CARD_TITLE,
        "text": text.join(" "),
        "offscreen": {
            "title": OFFSCREEN_CARD_TITLE,
            "day": step.get("day"),
            "at_minutes": step.get("at_minutes"),
            "elapsed_minutes": step.get("elapsed_minutes"),
            "lines": lines,
        },
    }))
}

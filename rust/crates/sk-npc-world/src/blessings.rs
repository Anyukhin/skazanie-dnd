//! Перенос `server/blessings.mjs` — молитвы и благословения.
//!
//! Детерминированный модуль без модели. Малое благословение — существующее
//! состояние `minor-blessing` (`+1` к первой атаке, до продолжительного
//! отдыха). Обращение к богам — раз в сутки на героя, по попытке, а не по
//! успеху: молитва у святыни (проверка Религии) или жрец за пожертвование
//! (без броска, репутация фракций жреца). Провал ничего не отнимает; на
//! натуральной единице — знамение строкой из закрытой таблицы.
//!
//! Реестр `state.blessings.heroes` — минута последнего обращения и его исход.
//! Ключ `__proto__` как id героя JS кладёт присваиванием в прототип реестра:
//! в JSON записи нет, но чтение по ключу (и по именам её полей) её находит.

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::{js, re, text as jstext};
use sk_society::reputation_policy::faction_ids_for_npc;

use crate::common::{coalesce, digest, get, integer, is_prototype_key, js_max, member, object_entries, spread, text, text_str, Member};
use crate::npc_positioning::{normalize_npc_world_state, present_scene_npcs, scene_location_id};

/// `BLESSINGS_SCHEMA_VERSION` — версия среза благословений.
pub const BLESSINGS_SCHEMA_VERSION: i64 = 1;
pub const BLESSINGS_POLICY_ID: &str = "skazanie:blessings-v1";
/// `BLESSING_COMMAND_TYPES` — команда благословения; молитва идёт через `OperateSceneObject`.
pub const BLESSING_COMMAND_TYPES: [&str; 1] = ["ReceiveNpcBlessing"];
/// `BLESSING_CONDITION` — состояние малого благословения.
pub const BLESSING_CONDITION: &str = "minor-blessing";
pub const BLESSING_DURATION: &str = "until-long-rest";
pub const BLESSING_ATTACK_BONUS: i64 = 1;
pub const BLESSING_COOLDOWN_MINUTES: i64 = 1_440;
pub const PRAYER_SKILL: &str = "religion";
pub const PRAYER_ABILITY: &str = "int";
pub const PRAYER_DC: i64 = 12;
pub const PRAYER_MINUTES: i64 = 15;
pub const NPC_BLESSING_MINUTES: i64 = 15;
pub const BLESSING_DONATION_CP: i64 = 100;
pub const BLESSING_REPUTATION_DELTA: i64 = 2;
/// `PRAYER_OUTCOMES` — что молитва оставляет герою.
pub const PRAYER_OUTCOMES: [&str; 3] = ["blessed", "silence", "omen"];
/// `BLESSING_SOURCES` — откуда пришло благословение.
pub const BLESSING_SOURCES: [&str; 2] = ["shrine", "priest"];

const MAX_BLESSED_HEROES: usize = 12;

/// Знамения на натуральной единице: механики за ними нет.
const OMENS: [&str; 5] = [
    "Пламя над алтарём приседает и гаснет само собой. Никто его не тушил.",
    "Слова молитвы возвращаются глухим эхом — будто их не приняли, а вернули.",
    "По камню святыни проступает влага и стекает вниз тремя дорожками.",
    "На миг делается очень тихо: не слышно ни ветра, ни собственного дыхания.",
    "Тень от изваяния ложится не в ту сторону и держится так, пока герой не отступит.",
];

/// Запись реестра (`safeRecord`): минута последнего обращения — она же суточный слот.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlessingRecord {
    pub at_minutes: i64,
    pub source: String,
    /// Благословение и молчание закрывают сутки одинаково, но записаны по-разному.
    pub granted: bool,
    pub place_name: String,
    pub npc_id: String,
    pub npc_name: String,
}

impl BlessingRecord {
    pub fn to_json(&self) -> Value {
        json!({
            "at_minutes": self.at_minutes,
            "source": self.source,
            "granted": self.granted,
            "place_name": self.place_name,
            "npc_id": self.npc_id,
            "npc_name": self.npc_name,
        })
    }

    /// Поле записи, как его находит JS по имени ключа через прототип реестра.
    fn field(&self, key: &str) -> Option<Value> {
        Some(match key {
            "at_minutes" => json!(self.at_minutes),
            "source" => json!(self.source),
            "granted" => json!(self.granted),
            "place_name" => json!(self.place_name),
            "npc_id" => json!(self.npc_id),
            "npc_name" => json!(self.npc_name),
            _ => return None,
        })
    }
}

fn safe_record(value: Option<&Value>) -> Option<BlessingRecord> {
    let value = value.filter(|value| value.is_object())?;
    let source = text(value.get("source"), 20);
    Some(BlessingRecord {
        at_minutes: 0.max(integer(value.get("at_minutes"), 0)),
        source: if BLESSING_SOURCES.contains(&source.as_str()) { source } else { "shrine".to_string() },
        granted: js::is_true(value.get("granted")),
        place_name: text(value.get("place_name"), 180),
        npc_id: text(value.get("npc_id"), 120),
        npc_name: text(value.get("npc_name"), 160),
    })
}

#[derive(Debug, Clone, Default)]
struct Registry {
    heroes: IndexMap<String, BlessingRecord>,
    proto: Option<BlessingRecord>,
}

impl Registry {
    fn heroes_json(&self) -> Map<String, Value> {
        let mut keys: Vec<&String> = self.heroes.keys().collect();
        let mut indexed: Vec<&String> = keys.iter().copied().filter(|key| js::is_array_index_key(key)).collect();
        indexed.sort_by_key(|key| key.parse::<u64>().unwrap_or(0));
        keys.retain(|key| !js::is_array_index_key(key));
        indexed.into_iter().chain(keys).map(|key| (key.clone(), self.heroes[key].to_json())).collect()
    }

    fn to_json(&self) -> Value {
        json!({ "schema_version": BLESSINGS_SCHEMA_VERSION, "heroes": Value::Object(self.heroes_json()) })
    }

    /// `heroes[key] ?? null`: своя запись; `__proto__` — запись-прототип или
    /// `Object.prototype` (`{}`); функция прототипа — `{}`; поле записи-
    /// прототипа — его значение; иначе `None`.
    fn lookup(&self, key: &str) -> Option<Value> {
        if let Some(record) = self.heroes.get(key) {
            return Some(record.to_json());
        }
        if key == "__proto__" {
            return Some(self.proto.as_ref().map_or_else(|| json!({}), BlessingRecord::to_json));
        }
        if is_prototype_key(key) {
            return Some(json!({}));
        }
        self.proto.as_ref().and_then(|record| record.field(key))
    }
}

fn normalize(input: Option<&Value>) -> Registry {
    let source = input.filter(|value| value.is_object());
    let mut kept: IndexMap<String, BlessingRecord> = IndexMap::new();
    for (hero_id, record) in object_entries(coalesce(get(source, "heroes"), None)) {
        let id = text_str(&hero_id, 120);
        if let (false, Some(record)) = (id.is_empty(), safe_record(Some(&record))) {
            kept.insert(id, record);
        }
    }
    let mut evicted: Vec<String> = Vec::new();
    if kept.len() > MAX_BLESSED_HEROES {
        let mut ranked: Vec<(usize, i64, &String)> = kept.iter().enumerate().map(|(index, (id, record))| (index, record.at_minutes, id)).collect();
        ranked.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
        evicted = ranked.into_iter().take(kept.len() - MAX_BLESSED_HEROES).map(|(_, _, id)| id.clone()).collect();
    }
    let mut registry = Registry::default();
    for (id, record) in kept {
        if evicted.contains(&id) {
            continue;
        }
        // `heroes['__proto__'] = record` в JS меняет прототип реестра.
        if id == "__proto__" {
            registry.proto = Some(record);
        } else {
            registry.heroes.insert(id, record);
        }
    }
    registry
}

/// `normalizeBlessingState(input)`: реестр не больше чем на 12 героев;
/// лишние вытесняются по минуте обращения.
pub fn normalize_blessing_state(input: Option<&Value>) -> Value {
    normalize(input).to_json()
}

/// `blessingRecordFor(state, heroId)`: последнее обращение героя к богам.
///
/// Для ключей прототипа JS возвращает унаследованное значение: функцию или
/// `Object.prototype` (здесь — пустой объект с тем же поведением полей) либо
/// поле записи-прототипа (строку, число, флаг).
pub fn blessing_record_for(state: &Value, hero_id: &Value) -> Option<Value> {
    normalize(get(Some(state), "blessings")).lookup(&text(Some(hero_id), 120))
}

/// `heroIsBlessed(state, heroId)`: несёт ли герой благословение прямо сейчас.
pub fn hero_is_blessed(state: &Value, hero_id: &Value) -> bool {
    let conditions = member(get(get(Some(state), "mechanics"), "conditions"), &text(Some(hero_id), 120));
    let list = match conditions {
        Member::Own(Value::Array(items)) => items.as_slice(),
        _ => &[],
    };
    list.iter().any(|condition| js::string(coalesce(get(Some(condition), "id"), Some(condition))) == BLESSING_CONDITION)
}

/// Можно ли герою обращаться к богам (`blessingAvailabilityFor`). Числа JS:
/// у унаследованной записи (ключ прототипа) срок — `NaN`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BlessingAvailability {
    pub available: bool,
    pub next_at_minutes: f64,
    pub waits_minutes: f64,
}

impl BlessingAvailability {
    pub fn to_json(&self) -> Value {
        json!({ "available": self.available, "next_at_minutes": js::num(self.next_at_minutes), "waits_minutes": js::num(self.waits_minutes) })
    }
}

fn availability(record: Option<&Value>, at_minutes: Option<&Value>) -> BlessingAvailability {
    let now = 0.max(integer(at_minutes, 0)) as f64;
    if !js::truthy(record) {
        return BlessingAvailability { available: true, next_at_minutes: 0.0, waits_minutes: 0.0 };
    }
    let next = js::number(get(record, "at_minutes")) + BLESSING_COOLDOWN_MINUTES as f64;
    BlessingAvailability { available: now >= next, next_at_minutes: next, waits_minutes: js_max(0.0, next - now) }
}

/// `blessingAvailabilityFor(state, heroId, atMinutes)`: одна функция на
/// валидацию, карточку и подсказку.
pub fn blessing_availability_for(state: &Value, hero_id: &Value, at_minutes: Option<&Value>) -> BlessingAvailability {
    availability(blessing_record_for(state, hero_id).as_ref(), at_minutes)
}

/// `isPriestProfile(npc)`: служитель ли это — только по роли профиля.
pub fn is_priest_profile(npc: Option<&Value>) -> bool {
    jstext::test(
        re!(
            r"жре[цч]|жриц|(?<![а-яё])священн(?:ик|иц|ослужител)|иерей|иеромонах|настоятел|аббат|клирик|(?<![а-яё])монах|(?<![а-яё])монашк|(?<![а-яё])инок(?![а-яё])|проповедн|хранител[а-яё]{0,6} святилищ|служител[а-яё]{0,6} (?:храм|святилищ|бог)|priest|cleric|abbot|(?<![a-zа-яё])monk(?![a-zа-яё])|acolyte|послушни",
            "iu"
        ),
        &text(get(npc, "role"), 160),
    )
}

/// Жрец сцены: `{ id, name, role }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlessingPriest {
    pub id: String,
    pub name: String,
    pub role: String,
}

impl BlessingPriest {
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "name": self.name, "role": self.role })
    }
}

/// `blessingPriestsFor(state)`: живые видимые невраждебные служители сцены.
pub fn blessing_priests_for(state: &Value) -> Vec<BlessingPriest> {
    let world = normalize_npc_world_state(get(Some(state), "npc_world"), &Value::Null);
    present_scene_npcs(state)
        .into_iter()
        .filter(|npc| npc.get("visibility").and_then(Value::as_str) != Some("gm_only"))
        .filter(|npc| {
            let stance = member(world.get("stances"), &js::string(npc.get("id"))).field("stance");
            let stance = if stance.nullish() { "neutral".to_string() } else { js::string(stance.own()) };
            stance != "hostile"
        })
        .filter(|npc| is_priest_profile(Some(npc)))
        .map(|npc| BlessingPriest { id: js::string(npc.get("id")), name: text(npc.get("name"), 160), role: text(npc.get("role"), 160) })
        .collect()
}

/// `isBlessingPriest(state, npcId)`.
pub fn is_blessing_priest(state: &Value, npc_id: &Value) -> bool {
    let expected = text(Some(npc_id), 120);
    blessing_priests_for(state).iter().any(|npc| npc.id == expected)
}

/// `blessingFactionIdsFor(state, npcId)`: фракции жреца для пожертвования.
pub fn blessing_faction_ids_for(state: &Value, npc_id: &Value) -> Vec<String> {
    let expected = text(Some(npc_id), 120);
    let npcs = match get(get(Some(state), "social"), "npcs") {
        Some(Value::Array(items)) => items.as_slice(),
        _ => &[],
    };
    match npcs.iter().find(|npc| js::s(get(Some(npc), "id")) == expected) {
        Some(profile) if js::truthy(Some(profile)) => faction_ids_for_npc(Some(profile)),
        _ => Vec::new(),
    }
}

/// `blessingOmenFor(seed)`: тревожное знамение — чистая функция сида.
pub fn blessing_omen_for(seed: Option<&Value>) -> &'static str {
    let hex = digest(&[text(seed, 240), "omen".to_string()]);
    let index = i64::from_str_radix(&hex[..8], 16).unwrap_or(0) as usize % OMENS.len();
    OMENS[index]
}

/// `blessingsForViewer(state, viewer)`: карточка благословений для стола.
pub fn blessings_for_viewer(state: &Value, viewer: &Value) -> Value {
    let hero = json!(text(get(Some(viewer), "playerId"), 120));
    let elapsed = get(get(get(Some(state), "mechanics"), "world_time"), "elapsed_minutes");
    let at_minutes = json!(0.max(integer(elapsed, 0)));
    let record = blessing_record_for(state, &hero);
    let available = availability(record.as_ref(), Some(&at_minutes));
    let last = match &record {
        Some(record) if js::truthy(Some(record)) => {
            let mut last = Map::new();
            for key in ["source", "granted", "place_name", "npc_name", "at_minutes"] {
                if let Some(value) = get(Some(record), key) {
                    last.insert(key.to_string(), value.clone());
                }
            }
            Value::Object(last)
        }
        _ => Value::Null,
    };
    json!({
        "schema_version": BLESSINGS_SCHEMA_VERSION,
        "condition": BLESSING_CONDITION,
        "attack_bonus": BLESSING_ATTACK_BONUS,
        "donation_cp": BLESSING_DONATION_CP,
        "prayer_dc": PRAYER_DC,
        "prayer_skill": PRAYER_SKILL,
        "location_id": scene_location_id(state),
        "blessed": hero_is_blessed(state, &hero),
        "available": available.available,
        "waits_minutes": js::num(available.waits_minutes),
        "priests": blessing_priests_for(state).iter().map(BlessingPriest::to_json).collect::<Vec<_>>(),
        "last": last,
    })
}

/// `applyBlessingEvent(input, event, state)`: что событие меняет в реестре.
/// Срез своей версии на прочих событиях возвращается как есть.
pub fn apply_blessing_event(input: Option<&Value>, event: &Value, _state: &Value) -> Value {
    let kind = js::s(event.get("event_type"));
    let fast = input.filter(|raw| raw.get("schema_version").and_then(Value::as_f64) == Some(BLESSINGS_SCHEMA_VERSION as f64) && js::truthy(raw.get("heroes")));
    if kind != "ShrinePrayerResolved" && kind != "NpcBlessingGranted" {
        return fast.cloned().unwrap_or_else(|| normalize_blessing_state(input));
    }
    let (mut source, mut heroes) = match fast {
        Some(raw) => (spread(Some(raw)), spread(raw.get("heroes"))),
        None => {
            let registry = normalize(input);
            match registry.to_json() {
                Value::Object(map) => (map, registry.heroes_json()),
                _ => (Map::new(), Map::new()),
            }
        }
    };
    let empty = json!({});
    let payload = coalesce(event.get("payload"), Some(&empty));
    let hero_id = text(coalesce(get(payload, "hero_id"), event.get("actor_id")), 120);
    if hero_id.is_empty() {
        return match fast {
            Some(raw) => raw.clone(),
            None => Value::Object(source),
        };
    }
    let priest = kind == "NpcBlessingGranted";
    heroes.insert(
        hero_id,
        json!({
            "at_minutes": 0.max(integer(get(payload, "at_minutes"), 0)),
            "source": if priest { "priest" } else { "shrine" },
            // Молчание и знамение сутки закрывают, но благословением не являются.
            "granted": priest || text(get(payload, "outcome"), 20) == "blessed",
            "place_name": text(get(payload, "place_name"), 180),
            "npc_id": text(get(payload, "npc_id"), 120),
            "npc_name": text(get(payload, "npc_name"), 160),
        }),
    );
    source.insert("heroes".into(), Value::Object(heroes));
    normalize_blessing_state(Some(&Value::Object(source)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omen_is_a_pure_function_of_the_seed() {
        assert_eq!(blessing_omen_for(Some(&json!("x"))), blessing_omen_for(Some(&json!("x"))));
        assert!(OMENS.contains(&blessing_omen_for(None)));
    }

    #[test]
    fn priest_is_recognised_by_role_only() {
        assert!(is_priest_profile(Some(&json!({ "role": "Жрец рассвета" }))));
        assert!(is_priest_profile(Some(&json!({ "role": "иеромонах" }))));
        assert!(!is_priest_profile(Some(&json!({ "role": "освященный страж" }))));
        assert!(!is_priest_profile(Some(&json!({ "role": "кузнец", "tags": ["faction:priesthood-of-dawn"] }))));
    }
}

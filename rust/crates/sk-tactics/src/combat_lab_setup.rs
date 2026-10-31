//! Перенос `server/combat-lab-setup.mjs`: сборка боевой кампании стенда —
//! учебные герои по классу и копии героев кампаний D&D 2014, противники из
//! бестиария 2014 с инвентарём, арена из `COMBAT_LAB_MAPS`, оценка и
//! генерация стычки по правилам 2014 — и каталог стенда для интерфейса.
//!
//! Модуль только читает хранилище: JS берёт кампании-источники через
//! `loadCampaign` (в сервере — `eventStore.load(id).state`), а запасной путь и
//! список кампаний — через `getRoom`/`listRoomCodes` файлового `store.mjs`.
//! В Rust оба пути — трейт [`CampaignRooms`] (для `sk_store::EventStore` он
//! реализован здесь же) и необязательная функция загрузки в [`Sources`].
//! Собранное состояние ничего не пишет: в журнал его кладёт вызывающий.
//!
//! Ошибки — [`CombatLabSetupError`]: `CombatLabSetupError` JS с кодом и
//! статусом 400, а исключения, которые JS не оборачивает (`TypeError` на
//! мусоре, отказ карты, нормализации или инвентаря), — то же значение с их
//! именем (`name`) и без кода, если JS его не ставил.

use std::collections::{HashMap, HashSet};
use std::fmt;

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, text};
use sk_tactical::tactical_map::{
    cell_at, deserialize_tactical_map, legacy_cells_from_tactical_map, movement_step_blocked, reachable_cells, serialize_tactical_map,
    tactical_map_from_legacy_cells, LegacyMapOptions, TacticalMap, TacticalMapError,
};

/// `COMBAT_LAB_RULESET.id`.
pub const COMBAT_LAB_RULESET_ID: &str = "dnd_5e_2014";
/// `COMBAT_LAB_RULESET.version`.
pub const COMBAT_LAB_RULESET_VERSION: &str = "2014.1.0";
/// `COMBAT_LAB_RULESET.enabled_rule_packs`.
pub const COMBAT_LAB_RULE_PACKS: [&str; 1] = ["dnd_5e_2014"];

/// `COMBAT_LAB_RULESET` как JSON.
pub fn combat_lab_ruleset() -> Value {
    json!({ "id": COMBAT_LAB_RULESET_ID, "version": COMBAT_LAB_RULESET_VERSION, "enabled_rule_packs": COMBAT_LAB_RULE_PACKS })
}

/// `COMBAT_LAB_LIMITS.party`.
pub const COMBAT_LAB_PARTY_LIMIT: usize = 6;
/// `COMBAT_LAB_LIMITS.enemies`.
pub const COMBAT_LAB_ENEMY_LIMIT: usize = 12;

/// `COMBAT_LAB_LIMITS` как JSON.
pub fn combat_lab_limits() -> Value {
    json!({ "party": COMBAT_LAB_PARTY_LIMIT, "enemies": COMBAT_LAB_ENEMY_LIMIT })
}

/// `COMBAT_LAB_ENCOUNTER_THEMES`.
pub const COMBAT_LAB_ENCOUNTER_THEMES: [&str; 8] = ["generic", "goblinoids", "undead", "beasts", "raiders", "cultists", "dragons", "dungeon"];

const CLASS_IDS: [&str; 12] = ["barbarian", "bard", "cleric", "druid", "fighter", "monk", "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard"];

/// `CLASS_NAMES[classId]` по собственным ключам.
fn class_name(class_id: &str) -> Option<&'static str> {
    Some(match class_id {
        "barbarian" => "Варвар",
        "bard" => "Бард",
        "cleric" => "Жрец",
        "druid" => "Друид",
        "fighter" => "Воин",
        "monk" => "Монах",
        "paladin" => "Паладин",
        "ranger" => "Следопыт",
        "rogue" => "Плут",
        "sorcerer" => "Чародей",
        "warlock" => "Колдун",
        "wizard" => "Волшебник",
        _ => return None,
    })
}

/// `ownEntry(CLASS_NAMES, key)` истинно: собственный ключ.
fn class_name_truthy(class_id: &str) -> bool {
    class_name(class_id).is_some()
}

fn class_primary(class_id: &str) -> &'static str {
    match class_id {
        "bard" | "sorcerer" | "warlock" => "cha",
        "cleric" | "druid" => "wis",
        "monk" | "ranger" | "rogue" => "dex",
        "wizard" => "int",
        _ => "str",
    }
}

fn class_hit_die(class_id: &str) -> i64 {
    match class_id {
        "barbarian" => 12,
        "fighter" | "paladin" | "ranger" => 10,
        "sorcerer" | "wizard" => 6,
        _ => 8,
    }
}

/// `CLASS_WEAPONS[classId]`: `(dice, bonus, type, armor)`.
fn class_weapon(class_id: &str) -> (i64, i64, &'static str, i64) {
    match class_id {
        "barbarian" => (12, 3, "slashing", 15),
        "bard" => (8, 2, "slashing", 14),
        "cleric" => (8, 2, "bludgeoning", 16),
        "druid" => (6, 2, "bludgeoning", 14),
        "fighter" => (8, 3, "slashing", 18),
        "monk" => (6, 3, "bludgeoning", 16),
        "paladin" => (8, 3, "slashing", 18),
        "ranger" => (8, 3, "piercing", 16),
        "rogue" => (8, 3, "piercing", 14),
        "sorcerer" => (6, 1, "fire", 12),
        "warlock" => (10, 2, "force", 13),
        _ => (6, 1, "fire", 12),
    }
}

/// `CLASS_SPELLS[classId]`: ступени `(уровень, заклинания)`.
fn class_spell_tiers(class_id: &str) -> &'static [(i64, &'static [&'static str])] {
    match class_id {
        "bard" => &[(1, &["vicious-mockery", "healing-word"]), (3, &["dissonant-whispers", "shatter"])],
        "cleric" => &[(1, &["sacred-flame", "bless", "healing-word"]), (3, &["spiritual-weapon", "cure-wounds"]), (5, &["spirit-guardians"])],
        "druid" => &[(1, &["produce-flame", "entangle", "healing-word"]), (3, &["moonbeam"]), (5, &["call-lightning"])],
        "paladin" => &[(2, &["bless", "cure-wounds", "shield-of-faith"])],
        "ranger" => &[(2, &["hunters-mark", "cure-wounds"])],
        "sorcerer" | "wizard" => &[(1, &["fire-bolt", "magic-missile", "shield"]), (3, &["scorching-ray"]), (5, &["fireball", "counterspell"])],
        "warlock" => &[(1, &["eldritch-blast", "hex"]), (3, &["misty-step"]), (5, &["counterspell"])],
        _ => &[],
    }
}

fn theme_name(theme: &str) -> &'static str {
    match theme {
        "generic" => "Любые существа",
        "goblinoids" => "Гоблиноиды",
        "undead" => "Нежить",
        "beasts" => "Звери",
        "raiders" => "Разбойники и воины",
        "cultists" => "Культ и магия",
        "dragons" => "Драконы",
        _ => "Подземелье",
    }
}

fn difficulty_name(difficulty: &str) -> &'static str {
    match difficulty {
        "trivial" => "ниже лёгкой",
        "easy" => "лёгкой",
        "medium" => "средней",
        "hard" => "тяжёлой",
        _ => "смертельной",
    }
}

// --- ошибки ---------------------------------------------------------------

/// Отказ сборки стенда. `name` — класс ошибки JS: `CombatLabSetupError` для
/// отказов модуля, иначе имя исключения, которое JS пропустил наверх.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CombatLabSetupError {
    pub name: String,
    pub message: String,
    pub code: Option<String>,
}

impl CombatLabSetupError {
    pub const NAME: &'static str = "CombatLabSetupError";

    /// `new CombatLabSetupError(message, code)`.
    pub fn new(message: impl Into<String>, code: &str) -> Self {
        Self { name: Self::NAME.into(), message: message.into(), code: Some(code.into()) }
    }

    /// `new CombatLabSetupError(message)` — код по умолчанию.
    pub fn config(message: impl Into<String>) -> Self {
        Self::new(message, "INVALID_COMBAT_LAB_CONFIG")
    }

    /// Исключение рантайма JS (`TypeError`) без кода.
    pub fn type_error(message: impl Into<String>) -> Self {
        Self { name: "TypeError".into(), message: message.into(), code: None }
    }

    /// Прочее исключение, которое JS не оборачивает.
    pub fn other(name: impl Into<String>, message: impl Into<String>, code: Option<String>) -> Self {
        Self { name: name.into(), message: message.into(), code }
    }

    /// `error instanceof CombatLabSetupError`.
    pub fn is_setup(&self) -> bool {
        self.name == Self::NAME
    }

    /// HTTP-статус: у `CombatLabSetupError` — 400; маршрут JS отвечает 400 и
    /// на прочие исключения.
    pub fn status(&self) -> u16 {
        400
    }
}

impl fmt::Display for CombatLabSetupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CombatLabSetupError {}

impl From<TacticalMapError> for CombatLabSetupError {
    fn from(error: TacticalMapError) -> Self {
        let code = (error.name == TacticalMapError::NAME).then_some(error.code);
        Self::other(error.name, error.message, code)
    }
}

impl From<sk_rules::pause::Halt> for CombatLabSetupError {
    fn from(halt: sk_rules::pause::Halt) -> Self {
        use sk_rules::pause::Halt;
        match halt {
            Halt::Rule(error) => Self::other("RulesValidationError", error.message, Some(error.code)),
            Halt::Fault(fault) => Self::other(fault.name, fault.message, fault.code),
        }
    }
}

impl From<sk_economy::enemy_loadouts::EnemyLoadoutFailure> for CombatLabSetupError {
    fn from(error: sk_economy::enemy_loadouts::EnemyLoadoutFailure) -> Self {
        use sk_economy::enemy_loadouts::EnemyLoadoutFailure;
        match error {
            EnemyLoadoutFailure::Loadout(error) => Self::other("EnemyLoadoutError", error.message, Some(error.code)),
            EnemyLoadoutFailure::Instance(error) => Self::other("ItemInstanceError", error.message, Some(error.code)),
        }
    }
}

impl From<sk_chargen::starter_kit::StarterKitError> for CombatLabSetupError {
    fn from(error: sk_chargen::starter_kit::StarterKitError) -> Self {
        Self::type_error(error.to_string())
    }
}

impl From<sk_combat_base::dndsu_2014_content::ContentError> for CombatLabSetupError {
    fn from(error: sk_combat_base::dndsu_2014_content::ContentError) -> Self {
        use sk_combat_base::dndsu_2014_content::ContentError;
        let name = match &error {
            ContentError::Validation(_) => "ContentValidationError",
            ContentError::Type(_) => "TypeError",
            ContentError::Io(_) => "Error",
        };
        Self::other(name, error.message(), None)
    }
}

impl From<sk_combat_base::combat_lab_encounter_math::EncounterMathError> for CombatLabSetupError {
    fn from(error: sk_combat_base::combat_lab_encounter_math::EncounterMathError) -> Self {
        Self::type_error(error.0)
    }
}

type Result<T> = std::result::Result<T, CombatLabSetupError>;

fn null_read(value: Option<&Value>, key: &str) -> CombatLabSetupError {
    let kind = if value.is_none() { "undefined" } else { "null" };
    CombatLabSetupError::type_error(format!("Cannot read properties of {kind} (reading '{key}')"))
}

// --- источники кампаний ---------------------------------------------------

/// Хранилище кампаний для стенда: `listRoomCodes()` и `getRoom(code).state`
/// файлового `store.mjs`.
pub trait CampaignRooms {
    /// `listRoomCodes()`: коды кампаний.
    fn room_codes(&self) -> Result<Vec<String>>;
    /// `getRoom(code).state`: `None` — кампании нет (`state: null`).
    fn room_state(&self, code: &str) -> Result<Option<Value>>;
}

/// Хранилище без кампаний.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoRooms;

impl CampaignRooms for NoRooms {
    fn room_codes(&self) -> Result<Vec<String>> {
        Ok(Vec::new())
    }

    fn room_state(&self, _code: &str) -> Result<Option<Value>> {
        Ok(None)
    }
}

fn store_error(error: sk_store::StoreError) -> CombatLabSetupError {
    CombatLabSetupError::other("EventStoreError", error.message, Some(error.code.to_string()))
}

/// Событийное хранилище как источник стенда: коды — кампании журнала той же
/// формы, что имена файлов комнат (`/^[A-Z0-9-]+$/`), состояние — последний
/// снимок `load`; отсутствующая кампания — `None`, как `getRoom` без файла.
impl CampaignRooms for sk_store::EventStore {
    fn room_codes(&self) -> Result<Vec<String>> {
        let campaigns = self.list_campaigns().map_err(store_error)?;
        Ok(campaigns
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| !id.is_empty() && id.chars().all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '-'))
            .collect())
    }

    fn room_state(&self, code: &str) -> Result<Option<Value>> {
        match self.load(code, &sk_store::store::LoadOptions::default()) {
            Ok(loaded) => Ok(Some(std::sync::Arc::unwrap_or_clone(loaded.state))),
            Err(error) if error.code == "CAMPAIGN_NOT_FOUND" => Ok(None),
            Err(error) => Err(store_error(error)),
        }
    }
}

/// `loadCampaign(campaignId)`: состояние кампании (или `{ state }`); `Err` —
/// отказ, после которого JS берёт запасной путь `getRoom`.
pub type LoadCampaign<'a> = &'a dyn Fn(&str) -> Result<Option<Value>>;

/// Откуда стенд берёт кампании-источники.
#[derive(Clone, Copy)]
pub struct Sources<'a> {
    pub rooms: &'a dyn CampaignRooms,
    pub load_campaign: Option<LoadCampaign<'a>>,
}

impl<'a> Sources<'a> {
    pub fn new(rooms: &'a dyn CampaignRooms, load_campaign: Option<LoadCampaign<'a>>) -> Self {
        Self { rooms, load_campaign }
    }
}

impl Default for Sources<'_> {
    fn default() -> Self {
        Self { rooms: &NoRooms, load_campaign: None }
    }
}

/// `loadSourceCampaign(campaignId, loadCampaign)`.
fn load_source_campaign(campaign_id: &str, sources: &Sources<'_>) -> Result<Option<Value>> {
    let attempt = match sources.load_campaign {
        Some(load) => load(campaign_id),
        None => sources.rooms.room_state(campaign_id),
    };
    match attempt {
        // `loaded?.state ?? loaded`
        Ok(Some(loaded)) => Ok(Some(match loaded.get("state") {
            Some(state) if !state.is_null() => state.clone(),
            _ => loaded,
        })),
        Ok(None) => Ok(None),
        Err(_) => sources.rooms.room_state(campaign_id),
    }
}

// --- рыхлый вход ----------------------------------------------------------

fn nullish(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// `x != null`.
fn present(value: Option<&Value>) -> bool {
    js::present(value)
}

/// `Number.isSafeInteger(value)` без приведения.
fn strict_integer(value: Option<&Value>) -> Option<f64> {
    js::is_safe_integer(value).then(|| value.and_then(Value::as_f64).unwrap_or(f64::NAN))
}

fn assert_object(value: Option<&Value>, label: &str) -> Result<()> {
    if js::is_plain(value) {
        Ok(())
    } else {
        Err(CombatLabSetupError::config(format!("{label} должен быть объектом")))
    }
}

fn assert_allowed_fields(value: &Value, fields: &[&str], label: &str) -> Result<()> {
    if let Some(map) = value.as_object() {
        for key in js::keys(map) {
            if !fields.contains(&key.as_str()) {
                return Err(CombatLabSetupError::new(format!("Поле {label}.{key} запрещено"), "UNEXPECTED_COMBAT_LAB_FIELD"));
            }
        }
    }
    Ok(())
}

fn integer(value: Option<&Value>, label: &str, min: i64, max: i64) -> Result<i64> {
    match strict_integer(value) {
        Some(number) if number >= min as f64 && number <= max as f64 => Ok(number as i64),
        _ => Err(CombatLabSetupError::new(format!("{label} должен быть целым числом {min}..{max}"), "INVALID_COMBAT_LAB_VALUE")),
    }
}

fn is_str(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

// --- каталог --------------------------------------------------------------

fn class_catalog() -> Vec<Value> {
    let catalog = sk_chargen::starter_kit::starter_equipment_catalog_for(COMBAT_LAB_RULESET_ID, false);
    let classes = catalog.as_ref().and_then(|catalog| catalog.get("classes")).and_then(Value::as_array).cloned().unwrap_or_default();
    let mut entries: Vec<(String, String)> = classes
        .iter()
        .map(|entry| {
            let id = js::string(entry.get("class_id"));
            let name = class_name(&js::string(entry.get("class_id"))).map_or_else(|| id.clone(), str::to_string);
            (id, name)
        })
        .collect();
    entries.sort_by(|left, right| (left.0 != "fighter").cmp(&(right.0 != "fighter")).then_with(|| text::locale_compare(&left.0, &right.0)));
    entries.into_iter().map(|(id, name)| json!({ "id": id, "name": name })).collect()
}

/// Бестиарий 2014 (`loadDndsu2014Content().monsters`).
fn monsters() -> Result<&'static [Value]> {
    let content = sk_combat_base::dndsu_2014_content::default_dndsu_2014_content()?;
    Ok(content.get("monsters").and_then(Value::as_array).map_or(&[], Vec::as_slice))
}

fn map_definition(id: &str) -> Option<&'static Value> {
    sk_map_core::combat_lab_maps::COMBAT_LAB_MAPS.iter().find(|map| map.get("id").and_then(Value::as_str) == Some(id))
}

// --- герои ----------------------------------------------------------------

fn ability_modifier(score: f64) -> f64 {
    ((score - 10.0) / 2.0).floor()
}

/// `standardAbilities(classId)` для класса профиля.
fn standard_abilities(class_id: &str) -> IndexMap<&'static str, i64> {
    let mut abilities: IndexMap<&'static str, i64> = [("str", 13), ("dex", 12), ("con", 14), ("int", 10), ("wis", 10), ("cha", 8)].into_iter().collect();
    let primary = class_primary(class_id);
    abilities.insert(primary, 16);
    if primary == "str" {
        abilities.insert("con", 15);
    }
    if primary == "dex" {
        abilities.insert("con", 14);
    }
    if ["wis", "int", "cha"].contains(&primary) {
        abilities.insert("dex", 14);
    }
    if class_id == "paladin" {
        abilities.insert("cha", 14);
        abilities.insert("con", 14);
    }
    if ["monk", "ranger"].contains(&class_id) {
        abilities.insert("wis", 14);
    }
    abilities
}

/// `classSpells(classId, level, abilities)`: `(known, prepared)`.
fn class_spells(class_id: &str, level: i64, abilities: &IndexMap<&'static str, i64>) -> (Vec<&'static str>, Vec<&'static str>) {
    let known: Vec<&'static str> = class_spell_tiers(class_id).iter().filter(|(tier, _)| *tier <= level).flat_map(|(_, ids)| ids.iter().copied()).collect();
    if known.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let prepared_class = ["cleric", "druid", "paladin", "wizard"].contains(&class_id);
    let capacity = if prepared_class {
        let modifier = ability_modifier(abilities.get(class_primary(class_id)).copied().unwrap_or(0) as f64);
        (level as f64 + modifier).max(1.0) as usize
    } else {
        known.len()
    };
    let prepared = known.iter().take(capacity).copied().collect();
    (known, prepared)
}

/// `trainingHero(classId, level, position, index)`.
fn training_hero(class_id: &str, level: i64, position: (i64, i64), index: usize) -> Result<Value> {
    let Some(class_label) = class_name(class_id) else {
        return Err(CombatLabSetupError::new(format!("Класс {class_id} не входит в профиль 2014"), "UNKNOWN_COMBAT_LAB_CLASS"));
    };
    let abilities = standard_abilities(class_id);
    let hit_die = class_hit_die(class_id);
    let con = ability_modifier(abilities["con"] as f64) as i64;
    let max_hp = (hit_die + con + (level - 1) * (hit_die / 2 + 1 + con)).max(1);
    let (dice, bonus, damage_type, armor) = class_weapon(class_id);
    let (known, prepared) = class_spells(class_id, level, &abilities);
    let tier_bonus = (level - 1).div_euclid(4);
    let primary_modifier = ability_modifier(abilities[class_primary(class_id)] as f64) as i64;
    let name = format!("{class_label} {}", index + 1);
    let abilities_json: Map<String, Value> = abilities.iter().map(|(key, value)| ((*key).to_string(), Value::from(*value))).collect();
    let base = json!({
        "id": format!("hero-{}", index + 1),
        "name": name,
        "character": name,
        "characterClass": class_id,
        "image": format!("/assets/ui/class-icons/{class_id}.webp"),
        "role": format!("{class_label} · ур. {level}"),
        "species": "Человек",
        "background": "Солдат",
        "level": level,
        "hp": max_hp,
        "maxHp": max_hp,
        "armor": armor,
        "speed": 30,
        "proficiency": 2 + tier_bonus,
        "abilities": abilities_json,
        "inventory": [],
        "online": true,
        "attackBonus": primary_modifier + 2 + tier_bonus,
        "damageDice": dice,
        "damageBonus": bonus,
        "damageType": damage_type,
        "attackRange": 5,
        "knownSpellIds": known,
        "preparedSpellIds": prepared,
        "x": position.0,
        "y": position.1,
    });
    let options = sk_chargen::starter_kit::StarterKitOptions { ruleset_id: COMBAT_LAB_RULESET_ID.into(), ..Default::default() };
    Ok(sk_chargen::starter_kit::with_starter_kit(Some(&base), &options)?)
}

/// `(state.players ?? []).find((candidate) => String(candidate.id) === heroId)`.
fn find_player<'a>(state: &'a Value, hero_id: &str, owner: &str) -> Result<Option<&'a Value>> {
    let players = match nullish(state.get("players")) {
        None => return Ok(None),
        Some(Value::Array(players)) => players,
        Some(_) => return Err(CombatLabSetupError::type_error(format!("({owner}.players ?? []).find is not a function"))),
    };
    for candidate in players {
        if candidate.is_null() {
            return Err(null_read(Some(candidate), "id"));
        }
        if js::string(candidate.get("id")) == hero_id {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// `Math.max(1, Math.min(12, Number(level) || 1))`.
fn clamped_level(value: Option<&Value>) -> f64 {
    let number = js::number(value);
    let number = if number == 0.0 || number.is_nan() { 1.0 } else { number };
    number.min(12.0).max(1.0)
}

/// `Math.max(1, Number(value) || 1)`.
fn at_least_one(value: Option<&Value>) -> f64 {
    let number = js::number(value);
    let number = if number == 0.0 || number.is_nan() { 1.0 } else { number };
    number.max(1.0)
}

/// `{ ...item }` для элемента инвентаря.
fn spread_item(item: &Value) -> Map<String, Value> {
    match item {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items.iter().enumerate().map(|(index, value)| (index.to_string(), value.clone())).collect(),
        // Строка распаковывается по кодовым единицам UTF-16; символы вне BMP
        // в `String` Rust не делятся на суррогаты и остаются целыми.
        Value::String(text) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Map::new(),
    }
}

fn type_label(value: &Value) -> String {
    match value {
        Value::String(text) => format!("string '{text}'"),
        Value::Number(number) => format!("number '{}'", js::js_number_string(number)),
        Value::Bool(flag) => format!("boolean '{flag}'"),
        _ => "object".into(),
    }
}

/// `heroFromCampaign(source, state, entry, position, arenaId)`.
fn hero_from_campaign(source: &str, state: &Value, entry: &Value, position: (i64, i64), arena_id: &str) -> Result<Value> {
    if js::string(state.get("ruleset_id")) != COMBAT_LAB_RULESET_ID {
        return Err(CombatLabSetupError::new("Копировать можно только героя из кампании D&D 2014", "SOURCE_RULESET_UNSUPPORTED"));
    }
    let hero_id = js::string(entry.get("heroId"));
    let Some(original) = find_player(state, &hero_id, "state")? else {
        return Err(CombatLabSetupError::new(format!("Герой {} не найден в кампании {source}", js::s(entry.get("heroId"))), "HERO_NOT_FOUND"));
    };
    if js::truthy(original.get("characterSetupRequired")) {
        return Err(CombatLabSetupError::new("Сначала завершите создание героя в его кампании", "HERO_SETUP_REQUIRED"));
    }
    let source_level = clamped_level(original.get("level"));
    if let Some(level) = nullish(entry.get("level")) {
        if level.as_f64() != Some(source_level) {
            return Err(CombatLabSetupError::new("Изменение уровня копии героя пока не поддержано; используйте training-класс", "HERO_LEVEL_OVERRIDE_UNSUPPORTED"));
        }
    }
    let Value::Object(mut copy) = original.clone() else {
        // Строгий режим ESM: свойство примитиву не присваивается.
        return Err(CombatLabSetupError::type_error(format!("Cannot create property 'id' on {}", type_label(original))));
    };
    let source_hero_id = js::string(copy.get("id"));
    copy.insert("id".into(), Value::String(arena_id.into()));
    let inventory = match nullish(copy.get("inventory")) {
        None => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(_) => return Err(CombatLabSetupError::type_error("(copy.inventory ?? []).map is not a function")),
    };
    let mut copied = Vec::with_capacity(inventory.len());
    for (index, item) in inventory.iter().enumerate() {
        if item.is_null() {
            return Err(null_read(Some(item), "id"));
        }
        let mut next = spread_item(item);
        next.insert("id".into(), Value::String(text::head(&format!("{arena_id}-item-{}", index + 1), 120)));
        match item.get("id") {
            Some(id) => {
                next.insert("source_item_id".into(), id.clone());
            }
            // `source_item_id: undefined` — поле выпадает из JSON.
            None => {
                next.shift_remove("source_item_id");
            }
        }
        copied.push(Value::Object(next));
    }
    copy.insert("inventory".into(), Value::Array(copied));
    copy.insert("source_campaign_id".into(), Value::String(source.into()));
    copy.insert("source_hero_id".into(), Value::String(source_hero_id));
    copy.insert("x".into(), Value::from(position.0));
    copy.insert("y".into(), Value::from(position.1));
    let hit_points = js::num(at_least_one(copy.get("maxHp")));
    copy.insert("hp".into(), hit_points.clone());
    copy.insert("maxHp".into(), hit_points);
    copy.insert("alive".into(), Value::Bool(true));
    copy.insert("online".into(), Value::Bool(true));
    Ok(Value::Object(copy))
}

// --- расстановка ----------------------------------------------------------

type Occupied = HashSet<(i64, i64)>;

/// `validateMapPlacement(map, entry, label, occupied, actor)`.
fn validate_map_placement(map: &TacticalMap, entry: &Value, label: &str, occupied: &mut Occupied, actor: Option<&Value>) -> Result<(i64, i64)> {
    let x = integer(entry.get("x"), &format!("{label}.x"), 0, map.width - 1)?;
    let y = integer(entry.get("y"), &format!("{label}.y"), 0, map.height - 1)?;
    let anchor = json!({ "x": x, "y": y });
    let cells = sk_geometry::actor_footprint::footprint_cells_for(actor, Some(&anchor));
    if cells.is_empty() || cells.iter().any(|cell| !cell_at(map, cell.x, cell.y).is_some_and(|cell| cell.passable)) {
        return Err(CombatLabSetupError::new(format!("{label} стоит на стене или выходит за карту"), "PLACEMENT_BLOCKED"));
    }
    let keys: HashSet<(i64, i64)> = cells.iter().map(|cell| (cell.x, cell.y)).collect();
    for cell in &cells {
        for (dx, dy) in [(1, 0), (0, 1)] {
            let next = (cell.x + dx, cell.y + dy);
            if keys.contains(&next) && movement_step_blocked(map, cell.x, cell.y, next.0, next.1)? {
                return Err(CombatLabSetupError::new(format!("{label} занимает перекрытую внутренним ребром площадь"), "PLACEMENT_BLOCKED"));
            }
        }
    }
    if cells.iter().any(|cell| occupied.contains(&(cell.x, cell.y))) {
        return Err(CombatLabSetupError::new(format!("{label} занимает уже занятую клетку"), "PLACEMENT_OCCUPIED"));
    }
    occupied.extend(cells.iter().map(|cell| (cell.x, cell.y)));
    Ok((x, y))
}

/// Пробная расстановка: отказ стенда — `false`, прочие исключения — наверх.
fn placement_fits(map: &TacticalMap, entry: &Value, label: &str, occupied: &Occupied, actor: Option<&Value>) -> Result<bool> {
    let mut preview = occupied.clone();
    match validate_map_placement(map, entry, label, &mut preview, actor) {
        Ok(_) => Ok(true),
        Err(error) if error.is_setup() => Ok(false),
        Err(error) => Err(error),
    }
}

/// `validateConfig(config)`: определение арены.
fn validate_config(config: Option<&Value>) -> Result<&'static Value> {
    assert_object(config, "config")?;
    let config = config.unwrap_or(&Value::Null);
    assert_allowed_fields(config, &["mapId", "party", "enemies"], "config")?;
    let map_id = config.get("mapId").filter(|value| js::truthy(Some(value))).map_or_else(String::new, |value| js::string(Some(value)));
    let Some(map) = map_definition(&map_id) else {
        return Err(CombatLabSetupError::new("Неизвестная карта боевого стенда", "UNKNOWN_COMBAT_LAB_MAP"));
    };
    let width = js::number(map.get("width")) as i64;
    let height = js::number(map.get("height")) as i64;
    let party = config.get("party").and_then(Value::as_array).filter(|party| !party.is_empty() && party.len() <= COMBAT_LAB_PARTY_LIMIT);
    let Some(party) = party else {
        return Err(CombatLabSetupError::new(format!("В отряде должно быть 1..{COMBAT_LAB_PARTY_LIMIT} участников"), "PARTY_LIMIT_EXCEEDED"));
    };
    let enemies = config.get("enemies").and_then(Value::as_array).filter(|enemies| !enemies.is_empty() && enemies.len() <= COMBAT_LAB_ENEMY_LIMIT);
    let Some(enemies) = enemies else {
        return Err(CombatLabSetupError::new(format!("У противников должно быть 1..{COMBAT_LAB_ENEMY_LIMIT} участников"), "ENEMY_LIMIT_EXCEEDED"));
    };
    for (index, entry) in party.iter().enumerate() {
        let label = format!("config.party[{index}]");
        assert_object(Some(entry), &label)?;
        assert_allowed_fields(entry, &["source", "campaignId", "heroId", "classId", "level", "x", "y"], &label)?;
        let hero = is_str(entry.get("source"), "hero");
        let class = is_str(entry.get("source"), "class");
        if !hero && !class {
            return Err(CombatLabSetupError::new("source должен быть hero или class", "INVALID_COMBAT_LAB_SOURCE"));
        }
        if hero && (!js::truthy(entry.get("campaignId")) || !js::truthy(entry.get("heroId"))) {
            return Err(CombatLabSetupError::new("Для source=hero нужны campaignId и heroId", "HERO_SOURCE_REQUIRED"));
        }
        if class && (!js::truthy(entry.get("classId")) || js::truthy(entry.get("campaignId")) || js::truthy(entry.get("heroId"))) {
            return Err(CombatLabSetupError::new("Для source=class нужен только classId", "CLASS_SOURCE_INVALID"));
        }
        if present(entry.get("level")) {
            integer(entry.get("level"), &format!("{label}.level"), 1, 12)?;
        }
        integer(entry.get("x"), &format!("{label}.x"), 0, width - 1)?;
        integer(entry.get("y"), &format!("{label}.y"), 0, height - 1)?;
    }
    for (index, entry) in enemies.iter().enumerate() {
        let label = format!("config.enemies[{index}]");
        assert_object(Some(entry), &label)?;
        assert_allowed_fields(entry, &["monsterId", "x", "y"], &label)?;
        if !js::truthy(entry.get("monsterId")) {
            return Err(CombatLabSetupError::new("Для противника нужен monsterId", "MONSTER_ID_REQUIRED"));
        }
        integer(entry.get("x"), &format!("{label}.x"), 0, width - 1)?;
        integer(entry.get("y"), &format!("{label}.y"), 0, height - 1)?;
    }
    Ok(map)
}

/// `combatLabCatalog({ loadCampaign })`.
pub fn combat_lab_catalog(sources: &Sources<'_>) -> Result<Value> {
    let monsters = monsters()?;
    let heroes = combat_lab_heroes(sources)?;
    let themes: Vec<Value> = COMBAT_LAB_ENCOUNTER_THEMES.iter().map(|id| json!({ "id": id, "name": theme_name(id) })).collect();
    Ok(json!({
        "heroes": heroes,
        "classes": class_catalog(),
        "monsters": monsters.iter().map(sk_combat_content::combat_lab_monsters::monster_catalog_entry).collect::<Vec<_>>(),
        "maps": sk_map_core::combat_lab_maps::combat_lab_map_catalog(),
        "encounterThemes": themes,
        "limits": combat_lab_limits(),
    }))
}

/// `for (const hero of state?.players ?? [])`: элементы для обхода.
fn iterable_players(state: Option<&Value>) -> Result<Vec<Value>> {
    match nullish(state.and_then(|state| state.get("players"))) {
        None => Ok(Vec::new()),
        Some(Value::Array(players)) => Ok(players.clone()),
        // Строка обходится по символам; у символа нет `id`, и он пропускается.
        Some(Value::String(_)) => Ok(Vec::new()),
        Some(Value::Object(_)) => Err(CombatLabSetupError::type_error("object is not iterable (cannot read property Symbol(Symbol.iterator))")),
        Some(other) => Err(CombatLabSetupError::type_error(format!("{} is not iterable (cannot read property Symbol(Symbol.iterator))", js::s(Some(other))))),
    }
}

/// `combatLabHeroes({ loadCampaign })`: готовые герои кампаний 2014.
pub fn combat_lab_heroes(sources: &Sources<'_>) -> Result<Vec<Value>> {
    let mut result: Vec<(String, Value)> = Vec::new();
    for campaign_id in sources.rooms.room_codes()? {
        let state = load_source_campaign(&campaign_id, sources)?;
        let ruleset = state.as_ref().and_then(|state| state.get("ruleset_id")).filter(|value| js::truthy(Some(value)));
        if ruleset.map_or_else(String::new, |value| js::string(Some(value))) != COMBAT_LAB_RULESET_ID {
            continue;
        }
        for hero in iterable_players(state.as_ref())? {
            if hero.is_null() {
                return Err(null_read(Some(&hero), "characterSetupRequired"));
            }
            if js::truthy(hero.get("characterSetupRequired")) {
                continue;
            }
            let id = js::s(hero.get("id"));
            if id.is_empty() {
                continue;
            }
            let name = [hero.get("name"), hero.get("character")].into_iter().flatten().find(|value| js::truthy(Some(value))).map_or_else(|| id.clone(), |value| js::s(Some(value)));
            let class_key = js::string(hero.get("characterClass"));
            let class_label = match class_name(&class_key) {
                Some(label) => Some(Value::String(label.into())),
                None => {
                    let role = hero.get("role").filter(|value| js::truthy(Some(value))).map_or_else(|| "Герой".to_string(), |value| js::s(Some(value)));
                    let head = role.split('·').next().unwrap_or("");
                    Some(Value::String(text::trim(head).to_string()))
                }
            };
            let campaign = text::upper(&campaign_id);
            let mut entry = Map::new();
            entry.insert("id".into(), Value::String(id.clone()));
            entry.insert("campaignId".into(), Value::String(campaign.clone()));
            entry.insert("name".into(), Value::String(name));
            if let Some(class_label) = class_label {
                entry.insert("className".into(), class_label);
            }
            entry.insert("level".into(), js::num(clamped_level(hero.get("level"))));
            result.push((format!("{campaign}:{id}"), Value::Object(entry)));
        }
    }
    result.sort_by(|left, right| text::locale_compare(&left.0, &right.0));
    Ok(result.into_iter().map(|(_, entry)| entry).collect())
}

// --- запрос стычки --------------------------------------------------------

/// Тема стычки после `ownEntry(ENCOUNTER_THEME_ALIASES, raw)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Theme {
    Known(&'static str),
}

impl Theme {
    /// Строка шаблона JS (`${theme}`).
    fn label(self) -> &'static str {
        match self {
            Theme::Known(theme) => theme,
        }
    }

    /// Значение в JSON.
    fn json(self) -> Option<Value> {
        match self {
            Theme::Known(theme) => Some(Value::String(theme.into())),
        }
    }
}

/// Опции `assessCombatLabEncounter`/`generateCombatLabEncounter`: поля поверх
/// тела запроса и источники кампаний.
#[derive(Clone, Copy, Default)]
pub struct EncounterOptions<'a> {
    pub difficulty: Option<&'a Value>,
    pub seed: Option<&'a Value>,
    pub theme: Option<&'a Value>,
    pub sources: Sources<'a>,
}

struct EncounterRequest<'a> {
    config: &'a Value,
    map_id: String,
    difficulty: String,
    difficulty_provided: bool,
    seed: String,
    theme: Theme,
}

fn normalize_encounter_seed(value: Option<&Value>) -> Result<String> {
    let Some(value) = nullish(value) else {
        return Ok("combat-lab".into());
    };
    if let Some(number) = strict_integer(Some(value)) {
        if (0.0..=4_294_967_295.0).contains(&number) {
            return Ok(js::s(Some(value)));
        }
    }
    let Value::String(raw) = value else {
        return Err(CombatLabSetupError::new("seed должен быть строкой или целым числом 0..4294967295", "INVALID_COMBAT_LAB_SEED"));
    };
    let seed = text::trim(raw);
    let control = seed.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}');
    if seed.is_empty() || seed.encode_utf16().count() > 120 || control {
        return Err(CombatLabSetupError::new("seed не прошёл проверку границ", "INVALID_COMBAT_LAB_SEED"));
    }
    Ok(seed.to_string())
}

fn normalize_encounter_theme(value: Option<&Value>) -> Result<Theme> {
    let value = nullish(value);
    if value.is_some_and(|value| !value.is_string()) {
        return Err(CombatLabSetupError::new("Тема автоматической стычки должна быть строкой", "UNKNOWN_COMBAT_LAB_THEME"));
    }
    let raw = text::lower(text::trim(value.and_then(Value::as_str).unwrap_or("generic")));
    let theme = match raw.as_str() {
        "generic" => Theme::Known("generic"),
        "goblin" | "goblinoids" => Theme::Known("goblinoids"),
        "undead" => Theme::Known("undead"),
        "beasts" | "beast" => Theme::Known("beasts"),
        "raiders" | "humanoids" => Theme::Known("raiders"),
        "cult" | "cultists" => Theme::Known("cultists"),
        "dragons" | "dragon" => Theme::Known("dragons"),
        "dungeon" => Theme::Known("dungeon"),
        _ => return Err(CombatLabSetupError::new("Неизвестная тема автоматической стычки", "UNKNOWN_COMBAT_LAB_THEME")),
    };
    Ok(theme)
}

/// `normalizeEncounterRequest(input, options)`.
fn normalize_encounter_request<'a>(input: Option<&'a Value>, options: &EncounterOptions<'_>) -> Result<EncounterRequest<'a>> {
    // `input = {}`: без тела — пустой запрос.
    static EMPTY: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| json!({}));
    let input = Some(input.unwrap_or(&EMPTY));
    assert_object(input, "request")?;
    let input = input.unwrap_or(&Value::Null);
    let wrapped = input.as_object().is_some_and(|map| map.contains_key("config"));
    if wrapped {
        assert_allowed_fields(input, &["config", "difficulty", "seed", "theme"], "request")?;
        assert_object(input.get("config"), "request.config")?;
        assert_allowed_fields(&input["config"], &["mapId", "party", "enemies"], "config")?;
    } else {
        assert_allowed_fields(input, &["mapId", "party", "enemies", "difficulty", "seed", "theme"], "request")?;
    }
    let config = if wrapped { &input["config"] } else { input };
    let difficulty_provided = present(options.difficulty) || present(input.get("difficulty"));
    let difficulty = nullish(options.difficulty).or_else(|| nullish(input.get("difficulty")));
    let difficulty = match difficulty {
        None => "medium".to_string(),
        Some(Value::String(difficulty)) if sk_combat_base::combat_lab_encounter_math::COMBAT_LAB_ENCOUNTER_DIFFICULTIES.contains(&difficulty.as_str()) => difficulty.clone(),
        Some(_) => return Err(CombatLabSetupError::new("difficulty должен быть easy, medium, hard или deadly", "INVALID_COMBAT_LAB_DIFFICULTY")),
    };
    let map_id = nullish(config.get("mapId"));
    if map_id.is_some_and(|value| !value.is_string()) {
        return Err(CombatLabSetupError::new("mapId должен быть строкой", "UNKNOWN_COMBAT_LAB_MAP"));
    }
    let map_id = map_id.and_then(Value::as_str).unwrap_or("open-courtyard").to_string();
    if map_definition(&map_id).is_none() {
        return Err(CombatLabSetupError::new("Неизвестная карта боевого стенда", "UNKNOWN_COMBAT_LAB_MAP"));
    }
    let seed = normalize_encounter_seed(nullish(options.seed).or_else(|| input.get("seed")))?;
    let theme = normalize_encounter_theme(nullish(options.theme).or_else(|| input.get("theme")))?;
    Ok(EncounterRequest { config, map_id, difficulty, difficulty_provided, seed, theme })
}

fn coordinate_check(entry: &Value, label: &str) -> Result<()> {
    for name in ["x", "y"] {
        if present(entry.get(name)) && strict_integer(entry.get(name)).is_none() {
            return Err(CombatLabSetupError::new(format!("{label}.{name} должен быть целым числом"), "INVALID_COMBAT_LAB_VALUE"));
        }
    }
    Ok(())
}

/// `normalizeEncounterParty(party)`.
fn normalize_encounter_party(party: Option<&Value>) -> Result<Vec<Map<String, Value>>> {
    let party = party.and_then(Value::as_array).filter(|party| !party.is_empty() && party.len() <= COMBAT_LAB_PARTY_LIMIT);
    let Some(party) = party else {
        return Err(CombatLabSetupError::new(format!("В отряде должно быть 1..{COMBAT_LAB_PARTY_LIMIT} участников"), "PARTY_LIMIT_EXCEEDED"));
    };
    let mut entries = Vec::with_capacity(party.len());
    for (index, entry) in party.iter().enumerate() {
        let label = format!("config.party[{index}]");
        assert_object(Some(entry), &label)?;
        assert_allowed_fields(entry, &["source", "campaignId", "heroId", "classId", "level", "x", "y"], &label)?;
        let hero = is_str(entry.get("source"), "hero");
        let class = is_str(entry.get("source"), "class");
        if !hero && !class {
            return Err(CombatLabSetupError::new("source должен быть hero или class", "INVALID_COMBAT_LAB_SOURCE"));
        }
        let non_empty = |key: &str| entry.get(key).and_then(Value::as_str).is_some_and(|text| !text.is_empty());
        if hero && (!non_empty("campaignId") || !non_empty("heroId")) {
            return Err(CombatLabSetupError::new("Для source=hero нужны campaignId и heroId", "HERO_SOURCE_REQUIRED"));
        }
        if class && (!non_empty("classId") || js::truthy(entry.get("campaignId")) || js::truthy(entry.get("heroId"))) {
            return Err(CombatLabSetupError::new("Для source=class нужен только classId", "CLASS_SOURCE_INVALID"));
        }
        if present(entry.get("level")) {
            integer(entry.get("level"), &format!("{label}.level"), 1, 12)?;
        }
        coordinate_check(entry, &label)?;
        entries.push(entry.as_object().cloned().unwrap_or_default());
    }
    Ok(entries)
}

/// `normalizeEncounterEnemies(enemies)`.
fn normalize_encounter_enemies(enemies: Option<&Value>) -> Result<Vec<Value>> {
    let Some(enemies) = nullish(enemies) else {
        return Ok(Vec::new());
    };
    let enemies = enemies.as_array().filter(|enemies| enemies.len() <= COMBAT_LAB_ENEMY_LIMIT);
    let Some(enemies) = enemies else {
        return Err(CombatLabSetupError::new(format!("У противников должно быть 0..{COMBAT_LAB_ENEMY_LIMIT} участников"), "ENEMY_LIMIT_EXCEEDED"));
    };
    let mut entries = Vec::with_capacity(enemies.len());
    for (index, entry) in enemies.iter().enumerate() {
        let label = format!("config.enemies[{index}]");
        assert_object(Some(entry), &label)?;
        assert_allowed_fields(entry, &["monsterId", "x", "y"], &label)?;
        if !entry.get("monsterId").and_then(Value::as_str).is_some_and(|text| !text.is_empty()) {
            return Err(CombatLabSetupError::new("Для противника нужен monsterId", "MONSTER_ID_REQUIRED"));
        }
        coordinate_check(entry, &label)?;
        entries.push(entry.clone());
    }
    Ok(entries)
}

struct ResolvedParty {
    entries: Vec<Map<String, Value>>,
    levels: Vec<Value>,
    warnings: Vec<String>,
}

/// `resolveEncounterParty(party, { loadCampaign })`.
fn resolve_encounter_party(party: Option<&Value>, sources: &Sources<'_>) -> Result<ResolvedParty> {
    let entries = normalize_encounter_party(party)?;
    let mut canonical = Vec::with_capacity(entries.len());
    let mut levels = Vec::with_capacity(entries.len());
    let mut warnings = Vec::new();
    let mut used_source_heroes: HashSet<String> = HashSet::new();
    for mut entry in entries {
        if is_str(entry.get("source"), "class") {
            let class_id = js::string(entry.get("classId"));
            if !class_name_truthy(&class_id) {
                return Err(CombatLabSetupError::new(format!("Класс {} не входит в профиль 2014", js::s(entry.get("classId"))), "UNKNOWN_COMBAT_LAB_CLASS"));
            }
            let level = nullish(entry.get("level")).cloned().unwrap_or_else(|| Value::from(1));
            entry.insert("classId".into(), Value::String(class_id));
            entry.insert("level".into(), level.clone());
            canonical.push(entry);
            levels.push(level);
            continue;
        }
        let source = text::upper(&js::string(entry.get("campaignId")));
        let hero_id = js::string(entry.get("heroId"));
        if !used_source_heroes.insert(format!("{source}:{hero_id}")) {
            return Err(CombatLabSetupError::new("Один герой не может быть добавлен дважды", "DUPLICATE_HERO_SOURCE"));
        }
        let state = load_source_campaign(&source, sources)?;
        let ruleset = state.as_ref().and_then(|state| state.get("ruleset_id"));
        if js::string(ruleset) != COMBAT_LAB_RULESET_ID {
            return Err(CombatLabSetupError::new("Копировать можно только героя из кампании D&D 2014", "SOURCE_RULESET_UNSUPPORTED"));
        }
        let state = state.unwrap_or(Value::Null);
        let Some(original) = find_player(&state, &hero_id, "state")? else {
            return Err(CombatLabSetupError::new(format!("Герой {hero_id} не найден в кампании {source}"), "HERO_NOT_FOUND"));
        };
        if js::truthy(original.get("characterSetupRequired")) {
            return Err(CombatLabSetupError::new("Сначала завершите создание героя в его кампании", "HERO_SETUP_REQUIRED"));
        }
        let level = clamped_level(original.get("level"));
        if nullish(entry.get("level")).is_some_and(|value| value.as_f64() != Some(level)) {
            let name = [original.get("name"), original.get("character")].into_iter().flatten().find(|value| js::truthy(Some(value))).map_or_else(|| hero_id.clone(), |value| js::s(Some(value)));
            warnings.push(format!("Уровень героя «{name}» взят из кампании: {}.", js::f64_string(level)));
        }
        let footprint = sk_geometry::actor_footprint::normalize_footprint_metadata(original.get("footprint"));
        entry.insert("campaignId".into(), Value::String(source));
        entry.insert("heroId".into(), Value::String(hero_id));
        entry.insert("level".into(), js::num(level));
        if let Some(footprint) = footprint {
            entry.insert("footprint".into(), footprint.to_value());
        }
        canonical.push(entry);
        levels.push(js::num(level));
    }
    Ok(ResolvedParty { entries: canonical, levels, warnings })
}

/// `recordsForEnemyEntries(entries, loadedContent)`.
fn records_for_enemy_entries(entries: &[Value], monsters: &'static [Value]) -> Result<Vec<Value>> {
    let by_id: HashMap<String, &Value> = monsters.iter().map(|record| (js::string(record.get("id")), record)).collect();
    entries
        .iter()
        .map(|entry| {
            let id = js::string(entry.get("monsterId"));
            by_id.get(&id).map(|record| (*record).clone()).ok_or_else(|| CombatLabSetupError::new(format!("Монстр {} отсутствует в каталоге D&D 2014", js::s(entry.get("monsterId"))), "UNKNOWN_COMBAT_LAB_MONSTER"))
        })
        .collect()
}

/// `themeMatches(record, theme)`.
fn theme_matches(record: &Value, theme: Theme) -> bool {
    let Theme::Known(theme) = theme;
    if theme == "generic" {
        return true;
    }
    let full_id = js::string(record.get("id"));
    let id = full_id.rsplit(':').next().unwrap_or("");
    let kind = js::s(record.get("creature_type"));
    let subtypes: Vec<String> = record.get("subtypes").and_then(Value::as_array).map(|items| items.iter().map(|item| js::string(Some(item))).collect()).unwrap_or_default();
    match theme {
        "goblinoids" => subtypes.iter().any(|subtype| subtype == "goblinoid") || ["goblin", "bugbear", "hobgoblin", "kobold"].iter().any(|name| id.contains(name)),
        "undead" => kind == "undead",
        "beasts" => kind == "beast",
        "raiders" => ["bandit", "bandit-captain", "guard", "orc", "veteran", "gnoll"].contains(&id),
        "cultists" => ["cultist", "cult-fanatic", "acolyte", "mage"].contains(&id),
        "dragons" => kind == "dragon",
        "dungeon" => ["ooze", "undead", "monstrosity", "elemental"].contains(&kind.as_str()) || id == "giant-spider",
        _ => false,
    }
}

/// `monsterBreakdown(records)`.
fn monster_breakdown(records: &[Value]) -> Vec<Value> {
    let mut grouped: IndexMap<String, (Value, i64)> = IndexMap::new();
    for record in records {
        let id = js::string(record.get("id"));
        let count = grouped.get(&id).map_or(0, |(_, count)| *count) + 1;
        let entry = json!({
            "id": id,
            "name": js::string(record.get("name_ru")),
            "cr": js::string(record.get("challenge_rating")),
            "xp": js::num(js::number(record.get("xp"))),
            "count": count,
        });
        grouped.insert(id, (entry, count));
    }
    let mut values: Vec<(String, Value)> = grouped.into_iter().map(|(id, (mut entry, count))| {
        entry["count"] = Value::from(count);
        (id, entry)
    }).collect();
    values.sort_by(|left, right| text::locale_compare(&left.0, &right.0));
    values.into_iter().map(|(_, entry)| entry).collect()
}

/// `rosterCaveatWarnings(records, partyLevels)`.
fn roster_caveat_warnings(records: &[Value], party_levels: &[Value]) -> Vec<String> {
    if records.is_empty() {
        return Vec::new();
    }
    let ratings: Vec<f64> = records.iter().filter_map(|record| sk_combat_base::combat_lab_encounter_math::challenge_rating_value(record.get("challenge_rating"))).filter(|value| value.is_finite()).collect();
    let average = party_levels.iter().fold(0.0, |sum, level| sum + js::number(Some(level))) / party_levels.len() as f64;
    let mut warnings = Vec::new();
    let highest = js::max_of(ratings.iter().copied().chain([0.0]));
    if highest > average {
        warnings.push(format!(
            "Существо с ПО {} выше среднего уровня отряда ({}); одиночный удар может резко изменить бой.",
            js::f64_string(highest),
            js::to_fixed(average, 1)
        ));
    }
    let lowest = js::min_of(ratings.iter().copied().chain([highest]));
    if highest >= 1.0 && lowest > 0.0 && highest / lowest >= 4.0 {
        warnings.push("В ростере есть существа с сильно разным ПО: множитель посчитан по всем, но слабых существ по правилам можно не учитывать, если они не влияют на бой.".into());
    }
    warnings
}

fn rules_source_json() -> Value {
    let source = sk_combat_base::combat_lab_encounter_math::COMBAT_LAB_RULES_SOURCE_2014;
    json!({ "title": source.title, "url": source.url, "dndsu_url": source.dndsu_url, "edition": source.edition })
}

/// Сведения о подборе: `target_adjusted_xp`, `candidate_count`, `maximum_creatures`.
struct Selection {
    target_adjusted_xp: f64,
    candidate_count: usize,
    maximum_creatures: usize,
}

/// `assessmentForRecords(records, partyLevels, request, warnings, selection)`.
fn assessment_for_records(records: &[Value], party_levels: &[Value], request: &EncounterRequest<'_>, warnings: &[String], selection: Option<Selection>) -> Result<Value> {
    use sk_combat_base::combat_lab_encounter_math::{assess_encounter_roster, AssessmentRequest};
    let seed = Value::String(request.seed.clone());
    let base = assess_encounter_roster(AssessmentRequest { records, party_levels, difficulty: &request.difficulty, seed: Some(&seed) })?;
    let mut result_warnings: Vec<String> = warnings.to_vec();
    result_warnings.extend(roster_caveat_warnings(records, party_levels));
    let base_difficulty = js::s(base.get("difficulty"));
    if records.is_empty() {
        result_warnings.push("В стычке пока нет противников; добавьте существ или сгенерируйте состав.".into());
    } else if request.difficulty_provided && !js::truthy(base.get("matched")) {
        result_warnings.push(format!(
            "Фактическая опасность «{}» не совпадает с запросом «{}».",
            difficulty_name(&base_difficulty),
            difficulty_name(&request.difficulty)
        ));
    }
    let mut result = base.as_object().cloned().unwrap_or_default();
    match request.theme.json() {
        Some(theme) => {
            result.insert("theme".into(), theme);
        }
        None => {
            result.shift_remove("theme");
        }
    }
    result.insert("monsterBreakdown".into(), Value::Array(monster_breakdown(records)));
    result.insert("warnings".into(), json!(result_warnings));
    result.insert("source".into(), rules_source_json());
    result.insert("rulesetId".into(), Value::String(COMBAT_LAB_RULESET_ID.into()));
    result.insert("rulesetVersion".into(), Value::String(COMBAT_LAB_RULESET_VERSION.into()));
    if let Some(selection) = selection {
        result.insert(
            "selection".into(),
            json!({
                "generated": true,
                "targetAdjustedXp": js::num(selection.target_adjusted_xp),
                "candidateCount": selection.candidate_count,
                "maximumCreatures": selection.maximum_creatures,
            }),
        );
    }
    Ok(Value::Object(result))
}

/// `assessCombatLabEncounter(input, options)`: опасность заданного состава.
pub fn assess_combat_lab_encounter(input: Option<&Value>, options: &EncounterOptions<'_>) -> Result<Value> {
    let request = normalize_encounter_request(input, options)?;
    let resolved = resolve_encounter_party(request.config.get("party"), &options.sources)?;
    let monsters = monsters()?;
    let enemy_entries = normalize_encounter_enemies(request.config.get("enemies"))?;
    let records = records_for_enemy_entries(&enemy_entries, monsters)?;
    assessment_for_records(&records, &resolved.levels, &request, &resolved.warnings, None)
}

fn passable_map_cells(map: &TacticalMap) -> Vec<Value> {
    legacy_cells_from_tactical_map(map)
        .into_iter()
        .filter(|entry| cell_at(map, js::number(entry.get("x")) as i64, js::number(entry.get("y")) as i64).is_some_and(|cell| cell.passable))
        .collect()
}

fn authored_spawn_cells(map: &TacticalMap, role: &str) -> Vec<Value> {
    map.spawn_points
        .iter()
        .filter(|point| point.role == role && cell_at(map, point.x, point.y).is_some_and(|cell| cell.passable))
        .map(|point| json!({ "x": point.x, "y": point.y }))
        .collect()
}

fn xy(entry: &Value) -> (i64, i64) {
    (js::number(entry.get("x")) as i64, js::number(entry.get("y")) as i64)
}

/// `positionPartyForGeneratedEncounter(map, entries)`.
fn position_party_for_generated_encounter(map: &TacticalMap, entries: Vec<Map<String, Value>>) -> Result<Vec<Map<String, Value>>> {
    let mut occupied = Occupied::new();
    let mut candidates = authored_spawn_cells(map, "party");
    candidates.extend(passable_map_cells(map));
    let mut positioned = Vec::with_capacity(entries.len());
    for (index, mut entry) in entries.into_iter().enumerate() {
        let has_x = present(entry.get("x"));
        let has_y = present(entry.get("y"));
        let label = format!("config.party[{index}]");
        if has_x != has_y {
            return Err(CombatLabSetupError::new(format!("{label} требует обе координаты"), "INVALID_COMBAT_LAB_VALUE"));
        }
        let footprint = entry.get("footprint").filter(|value| js::truthy(Some(value))).map(|footprint| json!({ "footprint": footprint }));
        let entry_value = Value::Object(entry.clone());
        let position = if has_x && has_y {
            validate_map_placement(map, &entry_value, &label, &mut occupied, footprint.as_ref())?
        } else {
            let mut next = None;
            for candidate in &candidates {
                if placement_fits(map, candidate, &label, &occupied, footprint.as_ref())? {
                    next = Some(candidate);
                    break;
                }
            }
            let Some(next) = next else {
                return Err(CombatLabSetupError::new("На карте нет свободной площади для героя", "NO_COMBAT_LAB_PLACEMENT"));
            };
            validate_map_placement(map, next, &label, &mut occupied, footprint.as_ref())?
        };
        entry.insert("x".into(), Value::from(position.0));
        entry.insert("y".into(), Value::from(position.1));
        positioned.push(entry);
    }
    Ok(positioned)
}

/// `enemyPositionsForGeneratedEncounter(map, party, records, seed)`.
fn enemy_positions_for_generated_encounter(map: &TacticalMap, party: &[Map<String, Value>], records: &[Value], seed: &str) -> Result<Vec<(i64, i64)>> {
    let members: Vec<(i64, i64)> = party.iter().map(|entry| (js::number(entry.get("x")) as i64, js::number(entry.get("y")) as i64)).collect();
    let mut occupied: Occupied = members.iter().copied().collect();
    let reachable = reachable_cells(map, members[0].0, members[0].1, true, None);
    if members.iter().any(|member| !reachable.contains(member)) {
        return Err(CombatLabSetupError::new("Герои должны находиться в одной достижимой области карты", "PLACEMENT_UNREACHABLE"));
    }
    let mut all = authored_spawn_cells(map, "enemy");
    all.extend(passable_map_cells(map));
    let mut seen: IndexSet<(i64, i64)> = IndexSet::new();
    let mut candidates: Vec<(Value, i64, String)> = Vec::new();
    for entry in all {
        let cell = xy(&entry);
        if !seen.insert(cell) {
            continue;
        }
        if !reachable.contains(&cell) || occupied.contains(&cell) {
            continue;
        }
        let distance = members.iter().map(|member| (cell.0 - member.0).abs() + (cell.1 - member.1).abs()).min().unwrap_or(i64::MAX);
        candidates.push((entry, distance, format!("{seed}:{},{}", cell.0, cell.1)));
    }
    candidates.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| text::locale_compare(&right.2, &left.2)));
    let mut positions = Vec::with_capacity(records.len());
    for (index, record) in records.iter().enumerate() {
        let footprint = json!({ "footprint": sk_geometry::actor_footprint::footprint_metadata_for_size(record.get("size")).to_value() });
        let label = format!("generated.enemies[{index}]");
        let mut found = None;
        for (candidate, _, _) in &candidates {
            if placement_fits(map, candidate, &label, &occupied, Some(&footprint))? {
                found = Some(candidate);
                break;
            }
        }
        let Some(candidate) = found else {
            return Err(CombatLabSetupError::new("На карте нет достаточной площади для противников", "NO_COMBAT_LAB_PLACEMENT"));
        };
        positions.push(validate_map_placement(map, candidate, &label, &mut occupied, Some(&footprint))?);
    }
    Ok(positions)
}

fn arena_map(definition: &Value) -> Result<TacticalMap> {
    Ok(deserialize_tactical_map(definition.get("map").unwrap_or(&Value::Null))?)
}

/// `generateCombatLabEncounter(input, options)`: `{ config, assessment }`.
pub fn generate_combat_lab_encounter(input: Option<&Value>, options: &EncounterOptions<'_>) -> Result<Value> {
    use sk_combat_base::combat_lab_encounter_math::{select_encounter_roster, RosterRequest};
    let request = normalize_encounter_request(input, options)?;
    let resolved = resolve_encounter_party(request.config.get("party"), &options.sources)?;
    let definition = map_definition(&request.map_id).ok_or_else(|| CombatLabSetupError::new("Неизвестная карта боевого стенда", "UNKNOWN_COMBAT_LAB_MAP"))?;
    let map = arena_map(definition)?;
    let party = position_party_for_generated_encounter(&map, resolved.entries)?;
    let monsters = monsters()?;
    let candidates: Vec<Value> = monsters.iter().filter(|record| theme_matches(record, request.theme)).cloned().collect();
    if candidates.is_empty() {
        return Err(CombatLabSetupError::new(format!("В теме «{}» нет доступных существ", request.theme.label()), "NO_COMBAT_LAB_THEME_MONSTERS"));
    }
    let seed = Value::String(request.seed.clone());
    let maximum = Value::from(COMBAT_LAB_ENEMY_LIMIT);
    let selection = select_encounter_roster(RosterRequest {
        records: &candidates,
        party_levels: &resolved.levels,
        difficulty: &request.difficulty,
        seed: Some(&seed),
        maximum_creatures: Some(&maximum),
    })
    .map_err(|_| CombatLabSetupError::new("В выбранной теме нет противников для этого уровня и опасности. Выберите другую тему или измените опасность.", "NO_COMBAT_LAB_ROSTER"))?;
    let positions = enemy_positions_for_generated_encounter(&map, &party, &selection.records, &request.seed)?;
    let enemies: Vec<Value> = selection
        .records
        .iter()
        .zip(&positions)
        .map(|(record, position)| json!({ "monsterId": js::string(record.get("id")), "x": position.0, "y": position.1 }))
        .collect();
    let config_party: Vec<Value> = party
        .into_iter()
        .map(|mut entry| {
            entry.shift_remove("footprint");
            Value::Object(entry)
        })
        .collect();
    let config = json!({ "mapId": request.map_id, "party": config_party, "enemies": enemies });
    let assessment = assessment_for_records(
        &selection.records,
        &resolved.levels,
        &request,
        &resolved.warnings,
        Some(Selection {
            target_adjusted_xp: selection.target_adjusted_xp,
            candidate_count: candidates.len(),
            maximum_creatures: COMBAT_LAB_ENEMY_LIMIT.min(resolved.levels.len() * 2),
        }),
    )?;
    Ok(json!({ "config": config, "assessment": assessment }))
}

/// `mapCells(map)`: старые клетки с пометкой труднопроходимости.
fn map_cells(map: &TacticalMap) -> Vec<Value> {
    legacy_cells_from_tactical_map(map)
        .into_iter()
        .map(|raw| {
            let (x, y) = xy(&raw);
            let mut cell = Map::new();
            cell.insert("x".into(), raw.get("x").cloned().unwrap_or(Value::Null));
            cell.insert("y".into(), raw.get("y").cloned().unwrap_or(Value::Null));
            if let Some(kind) = raw.get("type") {
                cell.insert("type".into(), kind.clone());
            }
            if cell_at(map, x, y).is_some_and(|cell| cell.move_cost > 1) {
                cell.insert("difficult".into(), Value::Bool(true));
            }
            Value::Object(cell)
        })
        .collect()
}

/// `buildCombatLabState(config, { loadCampaign })`: нормализованное состояние
/// боевой кампании стенда.
pub fn build_combat_lab_state(config: Option<&Value>, sources: &Sources<'_>) -> Result<Value> {
    let definition = validate_config(config)?;
    let config = config.unwrap_or(&Value::Null);
    let definition_id = js::s(definition.get("id"));
    let location = format!("combat-lab:{definition_id}");
    let map = if js::truthy(definition.get("map")) {
        arena_map(definition)?
    } else {
        let cells = definition.get("cells").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        tactical_map_from_legacy_cells(cells, &LegacyMapOptions { location_id: &location, seed: "", generator: None, tileset_id: "" })?
    };
    let mut occupied = Occupied::new();
    let mut party: Vec<Value> = Vec::new();
    let mut used_source_heroes: HashSet<String> = HashSet::new();
    let entries = config.get("party").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    for (index, entry) in entries.iter().enumerate() {
        let label = format!("config.party[{index}]");
        let hero = if is_str(entry.get("source"), "class") {
            let position = validate_map_placement(&map, entry, &label, &mut occupied, None)?;
            let level = nullish(entry.get("level")).and_then(Value::as_f64).unwrap_or(1.0) as i64;
            training_hero(&js::string(entry.get("classId")), level, position, index)?
        } else {
            let source = text::upper(&js::string(entry.get("campaignId")));
            if !used_source_heroes.insert(format!("{source}:{}", js::s(entry.get("heroId")))) {
                return Err(CombatLabSetupError::new("Один герой не может быть добавлен дважды", "DUPLICATE_HERO_SOURCE"));
            }
            let loaded = load_source_campaign(&source, sources)?;
            let Some(loaded) = loaded.filter(|loaded| !loaded.is_null()) else {
                return Err(null_read(Some(&Value::Null), "players"));
            };
            let original = find_player(&loaded, &js::string(entry.get("heroId")), "loaded")?;
            let placement_actor = original
                .and_then(|original| original.get("footprint"))
                .filter(|footprint| js::truthy(Some(footprint)))
                .map(|footprint| json!({ "footprint": sk_geometry::actor_footprint::normalize_footprint_metadata(Some(footprint)).map(|metadata| metadata.to_value()) }));
            let position = validate_map_placement(&map, entry, &label, &mut occupied, placement_actor.as_ref())?;
            hero_from_campaign(&source, &loaded, entry, position, &format!("hero-{}", index + 1))?
        };
        party.push(hero);
    }
    let monsters = monsters()?;
    let by_monster_id: HashMap<&str, &Value> = monsters.iter().filter_map(|record| record.get("id").and_then(Value::as_str).map(|id| (id, record))).collect();
    let mut enemies: Vec<Value> = Vec::new();
    let enemy_entries = config.get("enemies").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    for (index, entry) in enemy_entries.iter().enumerate() {
        let monster_id = js::string(entry.get("monsterId"));
        let Some(record) = by_monster_id.get(monster_id.as_str()).copied() else {
            return Err(CombatLabSetupError::new(format!("Монстр {} отсутствует в каталоге D&D 2014", js::s(entry.get("monsterId"))), "UNKNOWN_COMBAT_LAB_MONSTER"));
        };
        let footprint = json!({ "footprint": sk_geometry::actor_footprint::footprint_metadata_for_size(record.get("size")).to_value() });
        let position = validate_map_placement(&map, entry, &format!("config.enemies[{index}]"), &mut occupied, Some(&footprint))?;
        let mut enemy = sk_combat_content::combat_lab_monsters::enemy_from_2014(record, Some(&json!({ "x": position.0, "y": position.1 })), index as f64);
        let record_id = js::s(record.get("id"));
        let loadout = sk_economy::enemy_loadouts::enemy_loadout_for(Some(&json!({
            "statBlockId": record.get("id").cloned().unwrap_or(Value::Null),
            "block": enemy,
            "ownerId": enemy.get("id").cloned().unwrap_or(Value::Null),
            "seed": format!("combat-lab:{definition_id}:{record_id}:{index}"),
            "sourceId": "combat-lab",
        })))?;
        if let Some(map) = enemy.as_object_mut() {
            map.insert("loadout".into(), loadout);
        }
        enemies.push(enemy);
    }
    let Some(start) = party.first() else {
        return Err(null_read(None, "x"));
    };
    let start = xy(start);
    let reachable = reachable_cells(&map, start.0, start.1, true, None);
    for actor in party.iter().chain(&enemies) {
        if !reachable.contains(&xy(actor)) {
            return Err(CombatLabSetupError::new(format!("Клетка {},{} недостижима от первого героя", js::s(actor.get("x")), js::s(actor.get("y"))), "PLACEMENT_UNREACHABLE"));
        }
    }
    let cells: Vec<Value> = map_cells(&map)
        .into_iter()
        .map(|mut cell| {
            let difficult = js::truthy(cell.get("difficult"));
            if let Some(cell) = cell.as_object_mut() {
                cell.insert("revealed".into(), Value::Bool(true));
                if difficult {
                    cell.insert("moveCost".into(), Value::from(2));
                }
            }
            cell
        })
        .collect();
    let party_ids: Vec<Value> = party.iter().map(|actor| actor.get("id").cloned().unwrap_or(Value::Null)).collect();
    let active = party_ids.first().cloned().unwrap_or(Value::Null);
    let state = json!({
        "sessionCode": "COMBAT-LAB",
        "campaign": "Боевой стенд · настраиваемая арена",
        "partyName": "Тестовый отряд",
        "partyMemberIds": party_ids,
        "activePlayerId": active,
        "isNarrating": false,
        "pendingCheck": null,
        "suggestions": [],
        "messages": [],
        "players": party,
        "enemies": enemies,
        "scene": {
            "title": definition.get("name").cloned().unwrap_or(Value::Null),
            "location": location,
            "mood": "Тестовый бой",
            "objective": "Проверить боевые правила D&D 5e 2014",
            "turn": 1,
            "cells": cells,
            "map": serialize_tactical_map(&map)?,
        },
        "adventure": { "chapter": 1, "history": [], "visitedLocations": [location] },
        "ruleset_id": COMBAT_LAB_RULESET_ID,
        "ruleset_version": COMBAT_LAB_RULESET_VERSION,
        "enabled_rule_packs": COMBAT_LAB_RULE_PACKS,
        "enabled_house_rules": ["skazanie:2014-preview-legacy-catalogs-v1"],
        "engine_mode": "enforce",
    });
    Ok(sk_rules::normalize::normalize_campaign_state(&state)?)
}

/// Все классы профиля 2014 (`Object.keys(CLASS_NAMES)`).
pub fn combat_lab_class_ids() -> &'static [&'static str] {
    &CLASS_IDS
}

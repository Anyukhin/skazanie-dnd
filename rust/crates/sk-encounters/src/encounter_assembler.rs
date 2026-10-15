//! Перенос `server/encounter-assembler.mjs` — сборщик встречи.
//!
//! Вход — проверенный по границам снимок сцены (клетки), отряд, сложность,
//! тема и сид; выход — предложение встречи: противники с боевыми полями,
//! снаряжением и клеткой появления, бюджет опыта и источник стат-блоков. Всё
//! выводится из сида детерминированно: тот же вход — то же предложение.
//!
//! - Состав по сложности. SRD 5.2.1: бюджет опыта на героя (таблица со
//!   страницы 202), «смертельный» тир — серверный множитель к high; бюджет
//!   тратится полным перебором составов темы ([`spend_budget`]). Редакция
//!   2014: `selectEncounterRoster` по бестиарию MM14 (`sk-combat-base`).
//! - Расстановка. Враг появляется в подрайоне боя вокруг отряда
//!   (`combat-bounds`), в связной с отрядом области **по эту сторону дверей и
//!   окон** — за дверь он уходит, только когда здесь места нет вовсе
//!   (инвариант `AGENTS.md` §5, сторож `test/encounter-assembler.test.mjs`).
//!   Крупное тело не встаёт поперёк тонкой стены и не встаёт в карман, откуда
//!   оно не дойдёт до удара по отряду.
//! - Снаряжение — `enemyLoadoutFor` (`sk-economy`) по стат-блоку и сиду.
//!
//! Бестиарий SRD 5.2.1 (`SRD_5_2_1_MONSTER_ALLOWLIST`) лежит рядом в
//! `srd_5_2_1_monsters.json` — та же запись, что объект JS, ключ в ключ;
//! совпадение держит эталон `fixtures/encounter-assembler.json`.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_combat_base::combat_lab_encounter_math::{select_encounter_roster, EncounterMathError, EncounterRoster, RosterRequest};
use sk_combat_base::dndsu_2014_content::default_dndsu_2014_content;
use sk_combat_content::combat_lab_monsters::enemy_from_2014;
use sk_core::indexmap::IndexMap;
use sk_core::{hash, js, re, text};
use sk_economy::enemy_loadouts::{enemy_loadout_for, EnemyLoadoutFailure};
use sk_geometry::actor_footprint::{footprint_metadata_for_size, footprint_size_for};
use sk_scene_base::asset_registry::list_assets;
use sk_tactical::combat_bounds::{combat_bounds_contain, combat_bounds_useful_in, compute_combat_bounds_in};
use sk_tactical::tactical_map::{Bounds, SIZE_CLASSES};

/// `ENCOUNTER_PROPOSAL_VERSION`.
pub const ENCOUNTER_PROPOSAL_VERSION: &str = "skazanie:encounter-proposal-v1";

/// `ENCOUNTER_ASSEMBLER_LIMITS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EncounterAssemblerLimits {
    pub maximum_party_size: usize,
    /// Предел клеток един для всей системы и живёт в классах размеров карты
    /// (`SIZE_CLASSES.region.maxCells`, `sk-tactical`).
    pub maximum_scene_cells: usize,
    pub maximum_creatures_per_character: usize,
    pub maximum_creatures: usize,
    pub minimum_spawn_distance_cells: i64,
    pub maximum_seed_length: usize,
    pub maximum_actor_id_length: usize,
    pub minimum_character_level: i64,
    pub maximum_character_level: i64,
    pub minimum_coordinate: i64,
    pub maximum_coordinate: i64,
}

impl EncounterAssemblerLimits {
    /// Форма JS (порядок ключей объекта).
    pub fn to_json(&self) -> Value {
        json!({
            "maximum_party_size": self.maximum_party_size,
            "maximum_scene_cells": self.maximum_scene_cells,
            "maximum_creatures_per_character": self.maximum_creatures_per_character,
            "maximum_creatures": self.maximum_creatures,
            "minimum_spawn_distance_cells": self.minimum_spawn_distance_cells,
            "maximum_seed_length": self.maximum_seed_length,
            "maximum_actor_id_length": self.maximum_actor_id_length,
            "minimum_character_level": self.minimum_character_level,
            "maximum_character_level": self.maximum_character_level,
            "minimum_coordinate": self.minimum_coordinate,
            "maximum_coordinate": self.maximum_coordinate,
        })
    }
}

/// Класс `region` — третий в `SIZE_CLASSES` (порядок объекта JS).
const REGION_MAX_CELLS: i64 = SIZE_CLASSES[2].1.max_cells;

pub const ENCOUNTER_ASSEMBLER_LIMITS: EncounterAssemblerLimits = EncounterAssemblerLimits {
    maximum_party_size: 8,
    maximum_scene_cells: REGION_MAX_CELLS as usize,
    maximum_creatures_per_character: 2,
    maximum_creatures: 12,
    minimum_spawn_distance_cells: 2,
    maximum_seed_length: 120,
    maximum_actor_id_length: 120,
    minimum_character_level: 1,
    maximum_character_level: 20,
    minimum_coordinate: -1_000,
    maximum_coordinate: 1_000,
};

/// `SRD_5_2_1_SOURCE`.
pub static SRD_5_2_1_SOURCE: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "title": "System Reference Document 5.2.1",
        "version": "5.2.1",
        "published": "2025-05-01",
        "url": "https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf",
        "landing_url": "https://www.dndbeyond.com/srd",
        "sha256": SRD_5_2_1_SHA256,
        "license": "CC-BY-4.0",
        "attribution": "This work includes material from the System Reference Document 5.2.1 (\u{201c}SRD 5.2.1\u{201d}) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.",
        "encounter_budget_page": 202,
    })
});

const SRD_5_2_1_VERSION: &str = "5.2.1";
const SRD_5_2_1_SHA256: &str = "8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87";

/// `DND_SU_BESTIARY_SOURCE`.
pub static DND_SU_BESTIARY_SOURCE: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "title": "DnD.su — Бестиарий D&D 5",
        "url": "https://dnd.su/bestiary/",
        "checked_at": "2026-07-13",
        "role": "Russian names, compact stat-block cross-checks and gallery references",
    })
});

/// `SRD_5_2_1_MONSTER_ALLOWLIST` — серверная проекция стат-блоков SRD 5.2.1
/// на боевые поля движка, объект `{ "srd_5_2_1:<slug>": запись }`.
///
/// `damageDice` — число граней единственной кости основной атаки. Строки
/// `damage_vulnerabilities`, `damage_resistances`, `damage_immunities` и
/// `condition_immunities` объявлены только у существ, у которых они в SRD
/// действительно есть: отсутствие поля значит «в стат-блоке пусто». Условные
/// формулировки («немагическое оружие») не переносятся — движок не различает
/// магическое оружие (поэтому у зорна резистов нет). «Паутина» гигантского
/// паука — перезарядка 5–6 (`recharge: 5`), а не «раз за бой».
pub static SRD_5_2_1_MONSTER_ALLOWLIST: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("srd_5_2_1_monsters.json")).unwrap_or_else(|_| Value::Object(Map::new())));

fn srd_block(id: &str) -> Option<&'static Value> {
    SRD_5_2_1_MONSTER_ALLOWLIST.as_object().and_then(|map| map.get(id))
}

fn srd_xp(id: &str) -> i64 {
    srd_block(id).and_then(|block| block.get("xp")).and_then(Value::as_i64).unwrap_or(0)
}

/// Размеры SRD-профилей: источник площади, а не вход сборщика.
const SRD_5_2_1_MONSTER_SIZES: [(&str, &str); 50] = [
    ("srd_5_2_1:goblin-minion", "small"),
    ("srd_5_2_1:goblin-warrior", "small"),
    ("srd_5_2_1:skeleton", "medium"),
    ("srd_5_2_1:zombie", "medium"),
    ("srd_5_2_1:wolf", "medium"),
    ("srd_5_2_1:giant-rat", "small"),
    ("srd_5_2_1:giant-wolf-spider", "medium"),
    ("srd_5_2_1:giant-spider", "large"),
    ("srd_5_2_1:orc", "medium"),
    ("srd_5_2_1:hobgoblin", "medium"),
    ("srd_5_2_1:kobold", "small"),
    ("srd_5_2_1:bugbear", "medium"),
    ("srd_5_2_1:bandit", "medium"),
    ("srd_5_2_1:dire-wolf", "large"),
    ("srd_5_2_1:ghoul", "medium"),
    ("srd_5_2_1:gnoll-warrior", "medium"),
    ("srd_5_2_1:ogre", "large"),
    ("srd_5_2_1:owlbear", "large"),
    ("srd_5_2_1:scout", "medium"),
    ("srd_5_2_1:spy", "medium"),
    ("srd_5_2_1:giant-centipede", "small"),
    ("srd_5_2_1:violet-fungus", "medium"),
    ("srd_5_2_1:minotaur-skeleton", "large"),
    ("srd_5_2_1:ankylosaurus", "huge"),
    ("srd_5_2_1:berserker", "medium"),
    ("srd_5_2_1:lion", "large"),
    ("srd_5_2_1:brown-bear", "large"),
    ("srd_5_2_1:giant-boar", "large"),
    ("srd_5_2_1:tiger", "large"),
    ("srd_5_2_1:sahuagin-warrior", "medium"),
    ("srd_5_2_1:bandit-captain", "medium"),
    ("srd_5_2_1:warrior-veteran", "medium"),
    ("srd_5_2_1:ettin", "large"),
    ("srd_5_2_1:guard-captain", "medium"),
    ("srd_5_2_1:awakened-tree", "huge"),
    ("srd_5_2_1:giant-elk", "large"),
    ("srd_5_2_1:ogre-zombie", "large"),
    ("srd_5_2_1:knight", "medium"),
    ("srd_5_2_1:hippopotamus", "large"),
    ("srd_5_2_1:earth-elemental", "large"),
    ("srd_5_2_1:hill-giant", "huge"),
    ("srd_5_2_1:xorn", "large"),
    ("srd_5_2_1:animated-armor", "medium"),
    ("srd_5_2_1:ochre-jelly", "large"),
    ("srd_5_2_1:barbed-devil", "large"),
    ("srd_5_2_1:gladiator", "medium"),
    ("srd_5_2_1:giant-scorpion", "large"),
    ("srd_5_2_1:wyvern", "large"),
    ("srd_5_2_1:manticore", "large"),
    ("srd_5_2_1:tough-boss", "medium"),
];

/// `SRD_5_2_1_MONSTER_SIZES[id] ?? 'medium'` — метадата площади профиля.
fn srd_footprint(id: &str) -> Value {
    footprint_metadata_for_size(Some(&Value::from(srd_size(id).unwrap_or("medium")))).to_value()
}

fn srd_size(id: &str) -> Option<&'static str> {
    SRD_5_2_1_MONSTER_SIZES.iter().find(|(key, _)| *key == id).map(|(_, size)| *size)
}

/// `ENCOUNTER_THEMES` — порядок объекта `THEMES` JS.
pub const ENCOUNTER_THEMES: [&str; 13] =
    ["goblinoids", "undead", "beasts", "raiders", "warband", "law", "vermin", "ambush", "crypt", "cave", "wilderness", "cult", "generic"];

/// Темы — состав ростера, а не отдельный бестиарий: каждая перечисляет
/// подмножество того же allowlist. `generic` — весь allowlist по порядку.
const THEME_ROSTERS: [(&str, &[&str]); 12] = [
    ("goblinoids", &["srd_5_2_1:goblin-minion", "srd_5_2_1:goblin-warrior", "srd_5_2_1:hobgoblin", "srd_5_2_1:kobold", "srd_5_2_1:bugbear"]),
    ("undead", &["srd_5_2_1:skeleton", "srd_5_2_1:zombie", "srd_5_2_1:ghoul", "srd_5_2_1:minotaur-skeleton", "srd_5_2_1:ogre-zombie"]),
    (
        "beasts",
        &[
            "srd_5_2_1:wolf",
            "srd_5_2_1:dire-wolf",
            "srd_5_2_1:owlbear",
            "srd_5_2_1:giant-rat",
            "srd_5_2_1:giant-wolf-spider",
            "srd_5_2_1:giant-spider",
            "srd_5_2_1:giant-centipede",
            "srd_5_2_1:ankylosaurus",
            "srd_5_2_1:lion",
            "srd_5_2_1:brown-bear",
            "srd_5_2_1:giant-boar",
            "srd_5_2_1:tiger",
            "srd_5_2_1:giant-elk",
            "srd_5_2_1:hippopotamus",
        ],
    ),
    (
        "raiders",
        &[
            "srd_5_2_1:bandit",
            "srd_5_2_1:gnoll-warrior",
            "srd_5_2_1:ogre",
            "srd_5_2_1:orc",
            "srd_5_2_1:goblin-warrior",
            "srd_5_2_1:hobgoblin",
            "srd_5_2_1:bugbear",
            "srd_5_2_1:scout",
            "srd_5_2_1:spy",
            "srd_5_2_1:berserker",
            "srd_5_2_1:bandit-captain",
            "srd_5_2_1:warrior-veteran",
            "srd_5_2_1:ettin",
            "srd_5_2_1:hill-giant",
            "srd_5_2_1:gladiator",
            "srd_5_2_1:tough-boss",
        ],
    ),
    // Ватага: только тяжёлые бойцы, мало целей и каждая больно бьёт.
    (
        "warband",
        &[
            "srd_5_2_1:gnoll-warrior",
            "srd_5_2_1:ogre",
            "srd_5_2_1:orc",
            "srd_5_2_1:bugbear",
            "srd_5_2_1:hobgoblin",
            "srd_5_2_1:berserker",
            "srd_5_2_1:sahuagin-warrior",
            "srd_5_2_1:bandit-captain",
            "srd_5_2_1:warrior-veteran",
            "srd_5_2_1:ettin",
            "srd_5_2_1:guard-captain",
            "srd_5_2_1:knight",
            "srd_5_2_1:hill-giant",
            "srd_5_2_1:barbed-devil",
            "srd_5_2_1:gladiator",
            "srd_5_2_1:tough-boss",
        ],
    ),
    // Закон: те, кто носит чужую присягу. Бюджет тратится по всей теме, и
    // пока стража собиралась из «ватаги», у ворот деревни стоял дьявол.
    ("law", &["srd_5_2_1:scout", "srd_5_2_1:spy", "srd_5_2_1:warrior-veteran", "srd_5_2_1:knight", "srd_5_2_1:guard-captain"]),
    // Мелочь: много слабых существ, бой решается площадью, а не силой удара.
    (
        "vermin",
        &[
            "srd_5_2_1:giant-rat",
            "srd_5_2_1:kobold",
            "srd_5_2_1:goblin-minion",
            "srd_5_2_1:giant-centipede",
            "srd_5_2_1:violet-fungus",
            "srd_5_2_1:ochre-jelly",
            "srd_5_2_1:giant-scorpion",
        ],
    ),
    // Засада: быстрые и хрупкие, наказывают за растянутый строй.
    (
        "ambush",
        &[
            "srd_5_2_1:bandit",
            "srd_5_2_1:kobold",
            "srd_5_2_1:goblin-minion",
            "srd_5_2_1:giant-wolf-spider",
            "srd_5_2_1:wolf",
            "srd_5_2_1:dire-wolf",
            "srd_5_2_1:scout",
            "srd_5_2_1:spy",
            "srd_5_2_1:lion",
            "srd_5_2_1:tiger",
            "srd_5_2_1:bandit-captain",
            "srd_5_2_1:wyvern",
            "srd_5_2_1:manticore",
        ],
    ),
    // Склеп: нежить и то, что кормится в мёртвом месте.
    (
        "crypt",
        &[
            "srd_5_2_1:skeleton",
            "srd_5_2_1:zombie",
            "srd_5_2_1:ghoul",
            "srd_5_2_1:giant-rat",
            "srd_5_2_1:minotaur-skeleton",
            "srd_5_2_1:giant-centipede",
            "srd_5_2_1:ogre-zombie",
            "srd_5_2_1:animated-armor",
            "srd_5_2_1:ochre-jelly",
        ],
    ),
    // Пещера: обитатели подземелья вперемешку с тем, кто их туда загнал.
    (
        "cave",
        &[
            "srd_5_2_1:kobold",
            "srd_5_2_1:giant-spider",
            "srd_5_2_1:giant-rat",
            "srd_5_2_1:bugbear",
            "srd_5_2_1:ghoul",
            "srd_5_2_1:ogre",
            "srd_5_2_1:owlbear",
            "srd_5_2_1:giant-centipede",
            "srd_5_2_1:violet-fungus",
            "srd_5_2_1:minotaur-skeleton",
            "srd_5_2_1:brown-bear",
            "srd_5_2_1:ettin",
            "srd_5_2_1:awakened-tree",
            "srd_5_2_1:ogre-zombie",
            "srd_5_2_1:earth-elemental",
            "srd_5_2_1:hill-giant",
            "srd_5_2_1:xorn",
            "srd_5_2_1:animated-armor",
            "srd_5_2_1:ochre-jelly",
            "srd_5_2_1:barbed-devil",
            "srd_5_2_1:giant-scorpion",
        ],
    ),
    // Дикая местность: звери открытых пространств.
    (
        "wilderness",
        &[
            "srd_5_2_1:wolf",
            "srd_5_2_1:dire-wolf",
            "srd_5_2_1:owlbear",
            "srd_5_2_1:gnoll-warrior",
            "srd_5_2_1:giant-spider",
            "srd_5_2_1:giant-wolf-spider",
            "srd_5_2_1:scout",
            "srd_5_2_1:ankylosaurus",
            "srd_5_2_1:lion",
            "srd_5_2_1:brown-bear",
            "srd_5_2_1:giant-boar",
            "srd_5_2_1:tiger",
            "srd_5_2_1:awakened-tree",
            "srd_5_2_1:giant-elk",
            "srd_5_2_1:hippopotamus",
            "srd_5_2_1:hill-giant",
            "srd_5_2_1:giant-scorpion",
            "srd_5_2_1:wyvern",
            "srd_5_2_1:manticore",
        ],
    ),
    // Культ: в SRD 5.2.1 культистов нет — это разбойники, шпион и главари;
    // бестиарий MM14 добавляет культиста, фанатика и прислужника.
    ("cult", &["srd_5_2_1:bandit", "srd_5_2_1:spy", "srd_5_2_1:bandit-captain", "srd_5_2_1:tough-boss"]),
];

/// `THEMES[theme]`: состав темы или `None`, если темы нет.
fn theme_roster(theme: &str) -> Option<Vec<&'static str>> {
    if theme == "generic" {
        return Some(SRD_5_2_1_MONSTER_ALLOWLIST.as_object().map(|map| map.keys().map(String::as_str).collect()).unwrap_or_default());
    }
    THEME_ROSTERS.iter().find(|(key, _)| *key == theme).map(|(_, ids)| ids.to_vec())
}

/// `ENCOUNTER_DIFFICULTIES`.
pub const ENCOUNTER_DIFFICULTIES: [&str; 4] = ["easy", "medium", "hard", "deadly"];

/// `SRD_DIFFICULTY`: публичная сложность → столбец таблицы SRD.
fn srd_difficulty(difficulty: &str) -> usize {
    match difficulty {
        "easy" => 0,
        "medium" => 1,
        _ => 2,
    }
}

/// «Смертельно» — серверная политика, а не SRD: в редакции 5.2.1 четвёртого
/// тира нет, таблица заканчивается на high. Множитель применяется к high и
/// живёт отдельной константой, чтобы его нельзя было принять за строку SRD.
const DEADLY_BUDGET_MULTIPLIER: i64 = 2;
const DEADLY_DIFFICULTY: &str = "deadly";

/// `ENCOUNTER_DIFFICULTY_LABELS` — ярлык «на глаз» для стола; числа бюджета
/// игрокам не показываются.
pub const ENCOUNTER_DIFFICULTY_LABELS: [(&str, &str); 4] = [("easy", "лёгкий"), ("medium", "средний"), ("hard", "тяжёлый"), ("deadly", "смертельный")];

/// `ENCOUNTER_DIFFICULTY_LABELS` в форме объекта JS.
pub fn encounter_difficulty_labels_json() -> Value {
    Value::Object(ENCOUNTER_DIFFICULTY_LABELS.iter().map(|(key, label)| ((*key).to_string(), Value::from(*label))).collect())
}

/// Предупреждение до точки невозврата: бой ещё не начат, отступить можно.
pub const DEADLY_ENCOUNTER_WARNING: &str = "Противник выглядит смертельно опасным — силы явно неравны. Ещё не поздно отступить или сменить план.";

/// Свойства `Object.prototype`: `ENCOUNTER_DIFFICULTY_LABELS[key]` находит их
/// у замороженного объекта ярлыков.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

fn label_text(difficulty: &str) -> Option<&'static str> {
    ENCOUNTER_DIFFICULTY_LABELS.iter().find(|(key, _)| *key == difficulty).map(|(_, label)| *label)
}

/// `encounterDifficultyLabel(difficulty)`: ярлык сложности, незнакомое
/// значение — «средний».
///
/// Ключи `Object.prototype` JS находит у объекта ярлыков: `__proto__` даёт
/// `Object.prototype` (в JSON — `{}`), остальные — функцию, которую
/// `JSON.stringify` пропускает вместе с полем. Здесь это `Some(json!({}))` и
/// `None` соответственно (см. «Замечено в JS» отчёта переноса).
pub fn encounter_difficulty_label(difficulty: Option<&Value>) -> Option<Value> {
    let key = js::s(difficulty);
    if let Some(label) = label_text(&key) {
        return Some(Value::from(label));
    }
    if key == "__proto__" {
        return Some(Value::Object(Map::new()));
    }
    if OBJECT_PROTOTYPE_KEYS.contains(&key.as_str()) {
        return None;
    }
    label_text("medium").map(Value::from)
}

/// Ярлык уже проверенной сложности.
fn difficulty_label_value(difficulty: &str) -> Value {
    Value::from(label_text(difficulty).unwrap_or("средний"))
}

/// SRD 5.2.1, страница 202: бюджет опыта на героя `[low, moderate, high]`
/// по уровню 1–20.
const XP_BUDGET_PER_CHARACTER: [[i64; 3]; 20] = [
    [50, 75, 100],
    [100, 150, 200],
    [150, 225, 400],
    [250, 375, 500],
    [500, 750, 1_100],
    [600, 1_000, 1_400],
    [750, 1_300, 1_700],
    [1_000, 1_700, 2_100],
    [1_300, 2_000, 2_600],
    [1_600, 2_300, 3_100],
    [1_900, 2_900, 4_100],
    [2_200, 3_700, 4_700],
    [2_600, 4_200, 5_400],
    [2_900, 4_900, 6_200],
    [3_300, 5_400, 7_800],
    [3_800, 6_100, 9_800],
    [4_500, 7_200, 11_700],
    [5_000, 8_700, 14_200],
    [5_500, 10_700, 17_200],
    [6_400, 13_200, 22_000],
];

const TOP_LEVEL_KEYS: [&str; 6] = ["scene", "party", "difficulty", "theme", "seed", "ruleset_id"];
const SCENE_KEYS: [&str; 1] = ["cells"];
/// `occupied` появился с разделением слоёв: занятость клетки существом
/// передаётся явно, иначе двух противников можно поставить в одну клетку.
const CELL_KEYS: [&str; 7] = ["x", "y", "type", "revealed", "feature", "occupied", "walls"];
const PARTY_MEMBER_KEYS: [&str; 4] = ["id", "level", "x", "y"];
const CELL_TYPES: [&str; 4] = ["wall", "floor", "water", "door"];

/// Общие server-owned предметы карты — препятствия; каталог ассетов —
/// allowlist, чтобы тематический генератор не ломал встречу новым `assetId`.
static CELL_FEATURES: LazyLock<HashSet<String>> = LazyLock::new(|| {
    let legacy = [
        "chest", "altar", "torch", "rune", "stairs", "enemy", "bed", "table", "chair", "fireplace", "bookshelf", "barrel", "crate", "rock", "mushroom", "bones",
        "campfire", "grave", "pillar", "statue", "tree", "bush", "wagon", "well", "console",
    ];
    legacy.iter().map(|name| (*name).to_string()).chain(list_assets().iter().map(|asset| asset.id.clone())).collect()
});

/// Отказ сборщика (`EncounterAssemblyError`): код и текст — как в JS.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct EncounterAssemblyError {
    pub code: String,
    pub message: String,
}

impl EncounterAssemblyError {
    /// `error.name` в JS.
    pub const NAME: &'static str = "EncounterAssemblyError";

    fn new(message: impl Into<String>, code: &str) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

/// Отказ сборки: свой отказ сборщика или исключение модуля, которое JS
/// пропускает наружу как есть.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum AssembleFailure {
    #[error(transparent)]
    Assembly(#[from] EncounterAssemblyError),
    /// `TypeError` из `selectEncounterRoster` (редакция 2014).
    #[error(transparent)]
    Roster(#[from] EncounterMathError),
    /// Отказ `enemyLoadoutFor`.
    #[error(transparent)]
    Loadout(#[from] EnemyLoadoutFailure),
    /// Справочник 2014 не загрузился (в JS — падение импорта модуля).
    #[error("{0}")]
    Content(String),
}

impl AssembleFailure {
    /// Код отказа сборщика, если это он.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Assembly(error) => Some(&error.code),
            Self::Loadout(EnemyLoadoutFailure::Loadout(error)) => Some(&error.code),
            _ => None,
        }
    }
}

type AssemblyResult<T> = Result<T, EncounterAssemblyError>;

// --- проверка входа ----------------------------------------------------------

/// Клетка проверенной сцены.
#[derive(Clone, Debug)]
struct Cell {
    x: i64,
    y: i64,
    kind: &'static str,
    revealed: bool,
    feature: Option<String>,
    occupied: bool,
    /// `e`, `s` или `es`.
    walls: Option<&'static str>,
}

impl Cell {
    fn key(&self) -> (i64, i64) {
        (self.x, self.y)
    }

    fn walkable(&self) -> bool {
        self.kind == "floor" || self.kind == "door"
    }

    fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("x".into(), Value::from(self.x));
        map.insert("y".into(), Value::from(self.y));
        map.insert("type".into(), Value::from(self.kind));
        map.insert("revealed".into(), Value::Bool(self.revealed));
        if let Some(feature) = &self.feature {
            map.insert("feature".into(), Value::from(feature.as_str()));
        }
        if self.occupied {
            map.insert("occupied".into(), Value::Bool(true));
        }
        if let Some(walls) = self.walls {
            map.insert("walls".into(), Value::from(walls));
        }
        Value::Object(map)
    }
}

/// Участник отряда.
#[derive(Clone, Debug)]
struct Member {
    id: String,
    level: i64,
    x: i64,
    y: i64,
}

impl Member {
    fn key(&self) -> (i64, i64) {
        (self.x, self.y)
    }
}

struct Validated {
    cells: Vec<Cell>,
    party: Vec<Member>,
    difficulty: &'static str,
    theme: &'static str,
    seed: String,
    classic: bool,
}

impl Validated {
    /// `JSON.stringify(validated)`.
    fn canonical(&self) -> String {
        let mut map = Map::new();
        map.insert("cells".into(), Value::Array(self.cells.iter().map(Cell::to_json).collect()));
        map.insert(
            "party".into(),
            Value::Array(self.party.iter().map(|member| json!({ "id": member.id, "level": member.level, "x": member.x, "y": member.y })).collect()),
        );
        map.insert("difficulty".into(), Value::from(self.difficulty));
        map.insert("theme".into(), Value::from(self.theme));
        map.insert("seed".into(), Value::from(self.seed.as_str()));
        if self.classic {
            map.insert("ruleset_id".into(), Value::from("dnd_5e_2014"));
        }
        js::stringify(&Value::Object(map))
    }
}

fn reject_unexpected_keys(value: &Map<String, Value>, allowed: &[&str], code: &str) -> AssemblyResult<()> {
    if value.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(EncounterAssemblyError::new("Вход содержит поле, не разрешённое контрактом сборщика столкновения", code));
    }
    Ok(())
}

/// Длина строки JS (`text.length`): единицы UTF-16.
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn bounded_text(value: Option<&Value>, maximum: usize, code: &str, label: &str) -> AssemblyResult<String> {
    let Some(Value::String(raw)) = value else {
        return Err(EncounterAssemblyError::new(format!("{label} должен быть строкой"), code));
    };
    let result = text::trim(raw);
    if result.is_empty() || utf16_len(result) > maximum || text::test(re!(r"[\u0000-\u001f\u007f]", "u"), result) {
        return Err(EncounterAssemblyError::new(format!("{label} не прошёл проверку границ"), code));
    }
    Ok(result.to_string())
}

/// `Number.isSafeInteger(value)` без приведения: только число JSON.
fn safe_integer(value: Option<&Value>) -> Option<i64> {
    let number = value.filter(|value| value.is_number()).and_then(Value::as_f64)?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).then_some(number as i64)
}

fn coordinate(value: Option<&Value>, code: &str, label: &str) -> AssemblyResult<i64> {
    match safe_integer(value) {
        Some(number) if (ENCOUNTER_ASSEMBLER_LIMITS.minimum_coordinate..=ENCOUNTER_ASSEMBLER_LIMITS.maximum_coordinate).contains(&number) => Ok(number),
        _ => Err(EncounterAssemblyError::new(format!("{label} должен быть целым числом в разрешённых границах"), code)),
    }
}

fn plain(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn validate_scene(input: Option<&Value>) -> AssemblyResult<Vec<Cell>> {
    let scene = plain(input).ok_or_else(|| EncounterAssemblyError::new("scene должен быть объектом", "INVALID_SCENE"))?;
    reject_unexpected_keys(scene, &SCENE_KEYS, "UNEXPECTED_SCENE_FIELD")?;
    let entries = match scene.get("cells") {
        Some(Value::Array(entries)) if !entries.is_empty() && entries.len() <= ENCOUNTER_ASSEMBLER_LIMITS.maximum_scene_cells => entries,
        _ => return Err(EncounterAssemblyError::new("scene.cells должен быть непустым ограниченным массивом", "INVALID_SCENE_CELLS")),
    };
    let mut seen: HashSet<(i64, i64)> = HashSet::with_capacity(entries.len());
    let mut cells = Vec::with_capacity(entries.len());
    for entry in entries {
        let entry = plain(Some(entry)).ok_or_else(|| EncounterAssemblyError::new("Клетка сцены должна быть объектом", "INVALID_SCENE_CELL"))?;
        reject_unexpected_keys(entry, &CELL_KEYS, "UNEXPECTED_SCENE_CELL_FIELD")?;
        let x = coordinate(entry.get("x"), "INVALID_SCENE_CELL_COORDINATE", "cell.x")?;
        let y = coordinate(entry.get("y"), "INVALID_SCENE_CELL_COORDINATE", "cell.y")?;
        let kind = entry
            .get("type")
            .and_then(Value::as_str)
            .and_then(|kind| CELL_TYPES.iter().find(|known| **known == kind).copied())
            .ok_or_else(|| EncounterAssemblyError::new("Неизвестный тип клетки", "SCENE_CELL_TYPE_NOT_ALLOWED"))?;
        let Some(Value::Bool(revealed)) = entry.get("revealed") else {
            return Err(EncounterAssemblyError::new("cell.revealed должен быть boolean", "INVALID_SCENE_CELL_VISIBILITY"));
        };
        let feature = match entry.get("feature") {
            None | Some(Value::Null) => None,
            Some(Value::String(feature)) if CELL_FEATURES.contains(feature) => Some(feature.clone()),
            Some(_) => return Err(EncounterAssemblyError::new("Неизвестный объект в клетке", "SCENE_CELL_FEATURE_NOT_ALLOWED")),
        };
        let occupied = match entry.get("occupied") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => return Err(EncounterAssemblyError::new("cell.occupied должен быть boolean", "INVALID_SCENE_CELL_OCCUPANCY")),
        };
        // `/^(?:e|s|es)$/u`: тонкие стены на восточном и южном рёбрах.
        let walls = match entry.get("walls") {
            None | Some(Value::Null) => None,
            Some(Value::String(walls)) => Some(match walls.as_str() {
                "e" => "e",
                "s" => "s",
                "es" => "es",
                _ => return Err(EncounterAssemblyError::new("cell.walls должен быть e, s или es", "INVALID_SCENE_CELL_WALLS")),
            }),
            Some(_) => return Err(EncounterAssemblyError::new("cell.walls должен быть e, s или es", "INVALID_SCENE_CELL_WALLS")),
        };
        if !seen.insert((x, y)) {
            return Err(EncounterAssemblyError::new("Координаты клеток не должны повторяться", "DUPLICATE_SCENE_CELL"));
        }
        cells.push(Cell { x, y, kind, revealed: *revealed, feature, occupied, walls });
    }
    cells.sort_by(|left, right| left.y.cmp(&right.y).then(left.x.cmp(&right.x)));
    Ok(cells)
}

fn validate_party(input: Option<&Value>, cells: &[Cell]) -> AssemblyResult<Vec<Member>> {
    let entries = match input {
        Some(Value::Array(entries)) if !entries.is_empty() && entries.len() <= ENCOUNTER_ASSEMBLER_LIMITS.maximum_party_size => entries,
        _ => return Err(EncounterAssemblyError::new("party должен быть непустым ограниченным массивом", "INVALID_PARTY")),
    };
    let cells_by_position: HashMap<(i64, i64), &Cell> = cells.iter().map(|cell| (cell.key(), cell)).collect();
    let mut ids: HashSet<String> = HashSet::new();
    let mut positions: HashSet<(i64, i64)> = HashSet::new();
    let mut party = Vec::with_capacity(entries.len());
    for entry in entries {
        let entry = plain(Some(entry)).ok_or_else(|| EncounterAssemblyError::new("Участник группы должен быть объектом", "INVALID_PARTY_MEMBER"))?;
        reject_unexpected_keys(entry, &PARTY_MEMBER_KEYS, "UNEXPECTED_PARTY_MEMBER_FIELD")?;
        let id = bounded_text(entry.get("id"), ENCOUNTER_ASSEMBLER_LIMITS.maximum_actor_id_length, "INVALID_PARTY_MEMBER_ID", "party.id")?;
        if !ids.insert(id.clone()) {
            return Err(EncounterAssemblyError::new("ID участников группы не должны повторяться", "DUPLICATE_PARTY_MEMBER_ID"));
        }
        let level = match safe_integer(entry.get("level")) {
            Some(level) if (ENCOUNTER_ASSEMBLER_LIMITS.minimum_character_level..=ENCOUNTER_ASSEMBLER_LIMITS.maximum_character_level).contains(&level) => level,
            _ => return Err(EncounterAssemblyError::new("Уровень персонажа вне разрешённых границ", "PARTY_LEVEL_OUT_OF_RANGE")),
        };
        let x = coordinate(entry.get("x"), "INVALID_PARTY_MEMBER_COORDINATE", "party.x")?;
        let y = coordinate(entry.get("y"), "INVALID_PARTY_MEMBER_COORDINATE", "party.y")?;
        match cells_by_position.get(&(x, y)) {
            Some(cell) if cell.revealed && cell.walkable() => {}
            _ => return Err(EncounterAssemblyError::new("Персонаж должен находиться на открытой проходимой клетке", "PARTY_POSITION_NOT_WALKABLE")),
        }
        if !positions.insert((x, y)) {
            return Err(EncounterAssemblyError::new("Два персонажа не могут занимать одну клетку", "DUPLICATE_PARTY_POSITION"));
        }
        party.push(Member { id, level, x, y });
    }
    party.sort_by(|left, right| text::locale_compare(&left.id, &right.id));
    Ok(party)
}

fn validate_input(input: Option<&Value>) -> AssemblyResult<Validated> {
    let input = plain(input).ok_or_else(|| EncounterAssemblyError::new("Вход сборщика должен быть объектом", "INVALID_ENCOUNTER_INPUT"))?;
    reject_unexpected_keys(input, &TOP_LEVEL_KEYS, "UNEXPECTED_ENCOUNTER_FIELD")?;
    let cells = validate_scene(input.get("scene"))?;
    let party = validate_party(input.get("party"), &cells)?;
    let difficulty = input
        .get("difficulty")
        .and_then(Value::as_str)
        .and_then(|difficulty| ENCOUNTER_DIFFICULTIES.iter().find(|known| **known == difficulty).copied())
        .ok_or_else(|| EncounterAssemblyError::new("Неизвестная сложность столкновения", "ENCOUNTER_DIFFICULTY_NOT_ALLOWED"))?;
    // `Object.hasOwn(THEMES, theme)`: только собственные ключи, `constructor` — нет.
    let theme = input
        .get("theme")
        .and_then(Value::as_str)
        .and_then(|theme| ENCOUNTER_THEMES.iter().find(|known| **known == theme).copied())
        .ok_or_else(|| EncounterAssemblyError::new("Неизвестная тема столкновения", "ENCOUNTER_THEME_NOT_ALLOWED"))?;
    let seed = bounded_text(input.get("seed"), ENCOUNTER_ASSEMBLER_LIMITS.maximum_seed_length, "INVALID_ENCOUNTER_SEED", "seed")?;
    let ruleset = input.get("ruleset_id");
    if js::present(ruleset) && !matches!(ruleset.and_then(Value::as_str), Some("srd_5_2_1" | "dnd_5e_2014")) {
        return Err(EncounterAssemblyError::new("Редакция бестиария не установлена", "ENCOUNTER_RULESET_NOT_ALLOWED"));
    }
    let classic = ruleset.and_then(Value::as_str) == Some("dnd_5e_2014");
    Ok(Validated { cells, party, difficulty, theme, seed, classic })
}

// --- подрайон и клетки появления -----------------------------------------------

/// Габарит сетки по списку клеток: сборщик получает клетки, а не карту.
/// Сетка со сдвинутым началом (отрицательные координаты) не поддерживается —
/// тогда подрайон не считается вовсе.
fn grid_extent(cells: &[Cell]) -> Option<(i64, i64)> {
    let mut width = 0;
    let mut height = 0;
    for cell in cells {
        if cell.x < 0 || cell.y < 0 {
            return None;
        }
        width = width.max(cell.x + 1);
        height = height.max(cell.y + 1);
    }
    (width != 0 && height != 0).then_some((width, height))
}

/// Подрайон боя вокруг отряда (`docs/tactical-map-plan.md`, 11.4): противник
/// обязан появиться внутри него. Это не невидимая стена — подрайон
/// ограничивает только точку появления. `None` — карта слишком мала, чтобы
/// подрайон что-то значил.
fn spawn_bounds(cells: &[Cell], party: &[Member]) -> Option<Bounds> {
    let (width, height) = grid_extent(cells)?;
    if !combat_bounds_useful_in(width, height) {
        return None;
    }
    let points: Vec<(i64, i64)> = party.iter().map(Member::key).collect();
    compute_combat_bounds_in(width, height, &points, None)
}

/// `encounterBarrierSides(cell)`: стороны клетки, закрытые для шага, в форме
/// поля `walls` сборщика — тонкая стена **и окно**. Окно держит шаг, как
/// стена: прежде поиск появления «проходил» сквозь окно в запертый дом.
pub fn encounter_barrier_sides(cell: Option<&Value>) -> &'static str {
    let field = |key: &str| plain(cell).and_then(|map| map.get(key)).and_then(Value::as_str).unwrap_or("");
    let sides = format!("{}{}", field("walls"), field("windows"));
    let east = sides.contains('e');
    let south = sides.contains('s');
    match (east, south) {
        (true, true) => "es",
        (true, false) => "e",
        (false, true) => "s",
        (false, false) => "",
    }
}

type CellIndex<'a> = HashMap<(i64, i64), &'a Cell>;

/// Тонкая стена между соседними клетками: записана у западной или северной
/// клетки пары (`e` — восточное ребро, `s` — южное).
fn thin_wall_between(cells: &CellIndex<'_>, a: (i64, i64), b: (i64, i64)) -> bool {
    let has = |key: (i64, i64), side: char| cells.get(&key).and_then(|cell| cell.walls).is_some_and(|walls| walls.contains(side));
    if a.1 == b.1 && (a.0 - b.0).abs() == 1 {
        let west = if a.0 < b.0 { a } else { b };
        return has(west, 'e');
    }
    if a.0 == b.0 && (a.1 - b.1).abs() == 1 {
        let north = if a.1 < b.1 { a } else { b };
        return has(north, 's');
    }
    false
}

const STEPS: [(i64, i64); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

/// Клетки появления противника: сначала — по эту сторону дверей; только
/// если здесь места нет вовсе (тесная комната), враг может стоять за дверью.
fn safe_placement_cells<'a>(cells: &'a [Cell], party: &[Member], bounds: Option<&Bounds>) -> Vec<&'a Cell> {
    let same_area = placement_cells_within(cells, party, bounds, false);
    if same_area.is_empty() {
        placement_cells_within(cells, party, bounds, true)
    } else {
        same_area
    }
}

fn placement_cells_within<'a>(cells: &'a [Cell], party: &[Member], bounds: Option<&Bounds>, through_doors: bool) -> Vec<&'a Cell> {
    let occupied: HashSet<(i64, i64)> = party.iter().map(Member::key).collect();
    let walkable: CellIndex<'a> = cells.iter().filter(|cell| cell.revealed && cell.walkable() && !cell.occupied).map(|cell| (cell.key(), cell)).collect();
    let mut reachable: HashSet<(i64, i64)> = HashSet::new();
    let mut queue: Vec<&Cell> = party.iter().filter_map(|member| walkable.get(&member.key()).copied()).collect();
    let mut index = 0;
    while index < queue.len() {
        let current = queue[index];
        index += 1;
        let key = current.key();
        if !reachable.insert(key) {
            continue;
        }
        // Клетка двери досягаема, но сквозь неё поиск не идёт: за дверью —
        // уже другое помещение.
        if !through_doors && current.kind == "door" && !party.iter().any(|member| member.key() == key) {
            continue;
        }
        for (dx, dy) in STEPS {
            let Some(neighbor) = walkable.get(&(current.x + dx, current.y + dy)).copied() else { continue };
            // Сквозь тонкую стену враг к отряду не пройдёт — клетка не «рядом».
            if !reachable.contains(&neighbor.key()) && !thin_wall_between(&walkable, key, neighbor.key()) {
                queue.push(neighbor);
            }
        }
    }
    cells
        .iter()
        .filter(|cell| {
            combat_bounds_contain(bounds, cell.x, cell.y)
                && cell.revealed
                && cell.walkable()
                && reachable.contains(&cell.key())
                // Клетка двери может лежать по ту сторону полотна; в проёме врагу не место.
                && (through_doors || cell.kind != "door")
                && cell.feature.is_none()
                && !cell.occupied
                && !occupied.contains(&cell.key())
                && party.iter().all(|member| (member.x - cell.x).abs() + (member.y - cell.y).abs() >= ENCOUNTER_ASSEMBLER_LIMITS.minimum_spawn_distance_cells)
        })
        .collect()
}

fn digest(value: &str) -> String {
    hash::sha256_hex(value)
}

/// `seededTieBreak(left, right, seed)`. Сравнение шестнадцатеричных хешей
/// одной длины `localeCompare` совпадает с побайтовым: у цифр и `a`–`f` в ICU
/// по одному первичному весу в том же порядке, что в ASCII.
fn seeded_tie_break<'a>(left: &'a [&'static str], right: &'a [&'static str], seed: &str) -> &'a [&'static str] {
    let left_key = digest(&format!("{seed}\u{0}{}", left.join("|")));
    let right_key = digest(&format!("{seed}\u{0}{}", right.join("|")));
    if left_key < right_key {
        left
    } else {
        right
    }
}

/// Итог `spendBudget`.
struct Allocation {
    spent_xp: i64,
    stat_block_ids: Vec<&'static str>,
}

/// `spendBudget(catalogIds, budgetXp, quantityCap, seed)`: для каждой суммы
/// опыта — самый короткий состав, при равной длине — выбранный сидом; итог —
/// наибольшая сумма в пределах бюджета.
///
/// Порядок `Map` JS важен (новая сумма — в конец, замена — на месте), поэтому
/// состояния — `IndexMap`. Сортировка состава — `Array.prototype.sort` без
/// сравнителя, то есть по единицам UTF-16; id allowlist — ASCII, и побайтовый
/// порядок совпадает.
fn spend_budget(catalog_ids: &[&'static str], budget_xp: i64, quantity_cap: usize, seed: &str) -> Allocation {
    let mut states: IndexMap<i64, Vec<&'static str>> = IndexMap::new();
    states.insert(0, Vec::new());
    for count in 0..quantity_cap {
        let mut next = states.clone();
        for (spent, selection) in &states {
            if selection.len() != count {
                continue;
            }
            for catalog_id in catalog_ids {
                let next_spent = spent + srd_xp(catalog_id);
                if next_spent > budget_xp {
                    continue;
                }
                let mut candidate = selection.clone();
                candidate.push(catalog_id);
                candidate.sort_unstable();
                let replacement = match next.get(&next_spent) {
                    None => Some(candidate),
                    Some(current) if current.len() > candidate.len() => Some(candidate),
                    Some(current) if current.len() == candidate.len() => Some(seeded_tie_break(current, &candidate, seed).to_vec()),
                    Some(_) => None,
                };
                if let Some(replacement) = replacement {
                    next.insert(next_spent, replacement);
                }
            }
        }
        states = next;
    }
    let spent_xp = states.keys().copied().max().unwrap_or(0);
    let stat_block_ids = states.get(&spent_xp).cloned().unwrap_or_default();
    Allocation { spent_xp, stat_block_ids }
}

/// `deterministicOrder(values, seed, label)`: порядок клеток по хешу сида.
/// Хеш считается один раз на клетку; сравнитель JS устойчив и задаёт полный
/// порядок, поэтому устойчивая сортировка по тем же ключам даёт тот же ряд.
fn deterministic_order<'a>(values: &[&'a Cell], seed: &str, label: &str) -> Vec<&'a Cell> {
    let mut keyed: Vec<(String, String, &'a Cell)> = values
        .iter()
        .map(|cell| {
            let key = format!("{},{}", cell.x, cell.y);
            (digest(&format!("{seed}\u{0}{label}\u{0}{key}")), key, *cell)
        })
        .collect();
    keyed.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| text::locale_compare(&left.1, &right.1)));
    keyed.into_iter().map(|(_, _, cell)| cell).collect()
}

/// Клетки площади стороной `side` от верхнего левого угла (`footprintCellsFor`).
fn footprint(side: i64, anchor: (i64, i64)) -> Vec<(i64, i64)> {
    let mut cells = Vec::with_capacity((side * side).max(0) as usize);
    for dy in 0..side {
        for dx in 0..side {
            cells.push((anchor.0 + dx, anchor.1 + dy));
        }
    }
    cells
}

/// `placementFits(cellsByKey, actor, position, occupied)`.
fn placement_fits(cells: &CellIndex<'_>, side: i64, position: (i64, i64), occupied: &HashSet<(i64, i64)>) -> bool {
    let keys = footprint(side, position);
    // Крупное существо не стоит поперёк тонкой стены: площадь — одна комната.
    let inside: HashSet<(i64, i64)> = keys.iter().copied().collect();
    let crosses_wall = keys.iter().any(|cell| {
        [(1, 0), (0, 1)].iter().any(|(dx, dy)| {
            let neighbor = (cell.0 + dx, cell.1 + dy);
            inside.contains(&neighbor) && thin_wall_between(cells, *cell, neighbor)
        })
    });
    if crosses_wall {
        return false;
    }
    !keys.is_empty()
        && keys.iter().all(|key| {
            cells.get(key).is_some_and(|cell| cell.revealed && cell.walkable() && cell.feature.is_none() && !cell.occupied) && !occupied.contains(key)
        })
}

/// `strikeReachableAnchors(cellsByKey, party, side)`: якоря, откуда тело
/// стороной `side` дойдёт до удара по отряду.
///
/// Обратная заливка по положениям всего тела: от якорей, чья площадь касается
/// героя (5 футов), шагами по четырём сторонам, где тело целиком помещается и
/// не пересекает тонкую стену. Диагоналей нет — оценка осторожная: она может
/// отвергнуть место, но не пропустит карман. Множество — замыкание по этому
/// отношению, и порядок обхода на него не влияет.
fn strike_reachable_anchors(cells: &CellIndex<'_>, ordered: &[Cell], party: &[Member], side: i64) -> HashSet<(i64, i64)> {
    let party_keys: HashSet<(i64, i64)> = party.iter().map(Member::key).collect();
    let fits = |anchor: (i64, i64)| placement_fits(cells, side, anchor, &party_keys);
    let touches_party = |anchor: (i64, i64)| {
        footprint(side, anchor).iter().any(|cell| party.iter().any(|member| (member.x - cell.0).abs().max((member.y - cell.1).abs()) <= 1))
    };
    let mut reachable: HashSet<(i64, i64)> = HashSet::new();
    let mut queue: Vec<(i64, i64)> = Vec::new();
    for cell in ordered {
        let anchor = cell.key();
        if fits(anchor) && touches_party(anchor) {
            reachable.insert(anchor);
            queue.push(anchor);
        }
    }
    let mut index = 0;
    while index < queue.len() {
        let current = queue[index];
        index += 1;
        for (dx, dy) in STEPS {
            let next = (current.0 + dx, current.1 + dy);
            if reachable.contains(&next) || !fits(next) {
                continue;
            }
            // Каждая клетка тела переходит в соседнюю: ребро между ними не должно быть стеной.
            if footprint(side, current).iter().any(|cell| thin_wall_between(cells, *cell, (cell.0 + dx, cell.1 + dy))) {
                continue;
            }
            reachable.insert(next);
            queue.push(next);
        }
    }
    reachable
}

/// `deterministicEnemyPlacements`: ставит врагов по одному, резервируя все
/// клетки их площади.
fn deterministic_enemy_placements(cells: &[Cell], party: &[Member], enemies: &[Value], candidates: &[&Cell]) -> AssemblyResult<Vec<(i64, i64)>> {
    let cells_by_key: CellIndex<'_> = cells.iter().map(|cell| (cell.key(), cell)).collect();
    let mut occupied: HashSet<(i64, i64)> = party.iter().map(Member::key).collect();
    let mut reachable_by_side: HashMap<i64, HashSet<(i64, i64)>> = HashMap::new();
    let mut positions = Vec::with_capacity(enemies.len());
    for enemy in enemies {
        let side = footprint_size_for(Some(enemy));
        if side > 1 && !reachable_by_side.contains_key(&side) {
            reachable_by_side.insert(side, strike_reachable_anchors(&cells_by_key, cells, party, side));
        }
        let reachable = (side > 1).then(|| reachable_by_side.get(&side)).flatten();
        let position = candidates
            .iter()
            .map(|candidate| candidate.key())
            .find(|candidate| placement_fits(&cells_by_key, side, *candidate, &occupied) && reachable.is_none_or(|reachable| reachable.contains(candidate)));
        let Some(position) = position else {
            return Err(EncounterAssemblyError::new("Нет безопасной клетки для площади существа", "NO_SAFE_PLACEMENT_CELLS"));
        };
        positions.push(position);
        occupied.extend(footprint(side, position));
    }
    Ok(positions)
}

/// `cloneCatalogValue(value)`: глубокая копия записи каталога.
fn catalog_clone(value: Option<&Value>, fallback: Value) -> Value {
    match value {
        None | Some(Value::Null) => fallback,
        Some(value) => value.clone(),
    }
}

/// `block.x?.length` истинно: непустой массив (или строка) защит стат-блока.
fn non_empty_array(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| match value {
        Value::Array(items) => !items.is_empty(),
        Value::String(text) => !text.is_empty(),
        _ => false,
    })
}

/// Последний сегмент id (`id.split(':').at(-1)`).
fn slug_of(id: &str) -> &str {
    id.rsplit(':').next().unwrap_or("")
}

/// `encounter-<hash16>-<slug>-<n>`, не длиннее 120 символов.
fn enemy_id(proposal_hash: &str, slug: &str, index: usize) -> String {
    text::head(&format!("encounter-{}-{slug}-{}", &proposal_hash[..16], index + 1), 120)
}

/// `enemyLoadoutFor({ statBlockId, block, ownerId, seed, sourceId })`. Запись
/// `block` уходит во вход и возвращается обратно без копии.
fn loadout_for(stat_block_id: Value, block: Value, owner_id: &str, proposal_hash: &str, proposal_id: &str) -> Result<(Value, Value), EnemyLoadoutFailure> {
    let mut input = json!({ "statBlockId": stat_block_id, "block": block, "ownerId": owner_id, "seed": proposal_hash, "sourceId": proposal_id });
    let loadout = enemy_loadout_for(Some(&input))?;
    Ok((loadout, input["block"].take()))
}

/// `enemyFrom(statBlockId, position, proposalHash, index, ordinal, proposalId)`:
/// противник из стат-блока SRD 5.2.1.
fn enemy_from(stat_block_id: &str, position: (i64, i64), proposal_hash: &str, index: usize, ordinal: usize, proposal_id: &str) -> Result<Value, AssembleFailure> {
    let empty = Value::Object(Map::new());
    let block = srd_block(stat_block_id).unwrap_or(&empty);
    let field = |key: &str| block.get(key);
    let id = enemy_id(proposal_hash, slug_of(stat_block_id), index);
    let mut enemy = Map::new();
    enemy.insert("id".into(), Value::from(id.as_str()));
    enemy.insert("name".into(), Value::from(format!("{} {ordinal}", js::string(field("name")))));
    for (key, source) in [("hp", "hp"), ("maxHp", "hp"), ("armor", "armor"), ("speed", "speed"), ("initiativeBonus", "initiative_bonus"), ("attackBonus", "attackBonus"), ("damageDice", "damageDice"), ("damageBonus", "damageBonus")] {
        if let Some(value) = field(source) {
            enemy.insert(key.into(), value.clone());
        }
    }
    enemy.insert("abilities".into(), catalog_clone(field("abilities"), Value::Object(Map::new())));
    if let Some(kind) = field("creature_type") {
        enemy.insert("creature_type".into(), kind.clone());
    }
    enemy.insert("footprint".into(), srd_footprint(stat_block_id));
    // Пустые строки стат-блока не превращаются в пустые массивы: запись врага
    // остаётся той же формы, пока у существа нечего объявлять.
    for key in ["damage_vulnerabilities", "damage_resistances", "damage_immunities", "condition_immunities"] {
        if let Some(value) = non_empty_array(field(key)) {
            enemy.insert(key.into(), value.clone());
        }
    }
    for key in ["image", "source_url"] {
        if let Some(value) = field(key) {
            enemy.insert(key.into(), value.clone());
        }
    }
    enemy.insert("traits".into(), catalog_clone(field("traits"), json!([])));
    // Магия и легендарные действия — тем же условным спредом: движок их
    // исполняет, объявляет — стат-блок. Ни одна запись allowlist их сейчас не
    // несёт, но первая же запись с боссом не соберётся молча обычным существом.
    for key in ["spellcasting", "legendary"] {
        if let Some(value) = field(key).filter(|value| js::truthy(Some(value))) {
            enemy.insert(key.into(), value.clone());
        }
    }
    enemy.insert("action_profiles".into(), catalog_clone(field("action_profiles"), json!([])));
    enemy.insert("attack_profile".into(), catalog_clone(field("action_profiles").and_then(|profiles| profiles.get(0)), Value::Object(Map::new())));
    enemy.insert("x".into(), Value::from(position.0));
    enemy.insert("y".into(), Value::from(position.1));
    enemy.insert("alive".into(), Value::Bool(true));
    enemy.insert("stat_block_id".into(), Value::from(stat_block_id));
    // Инвентарь лежит рядом с боевой записью, а не в `inventory`: надетая вещь
    // иначе молча изменила бы КД или спасбросок противника. Сид кампании и
    // встречи уже свёрнут в `proposalHash`, id существа — третья составляющая.
    let (loadout, _) = loadout_for(Value::from(stat_block_id), block.clone(), &id, proposal_hash, proposal_id)?;
    enemy.insert("loadout".into(), loadout);
    let mut provenance = Map::new();
    provenance.insert("kind".into(), Value::from("server-owned-srd-primary-attack-projection"));
    provenance.insert("ruleset_id".into(), Value::from("srd_5_2_1"));
    provenance.insert("source_version".into(), Value::from(SRD_5_2_1_VERSION));
    provenance.insert("source_sha256".into(), Value::from(SRD_5_2_1_SHA256));
    for (key, source) in [("source_page", "source_page"), ("challenge_rating", "challenge_rating"), ("xp", "xp"), ("dndsu_url", "source_url")] {
        if let Some(value) = field(source) {
            provenance.insert(key.into(), value.clone());
        }
    }
    enemy.insert("provenance".into(), Value::Object(provenance));
    Ok(Value::Object(enemy))
}

/// Бестиарий MM14 по теме (`classicMonstersForTheme`), один раз на тему.
static CLASSIC_BY_THEME: LazyLock<Result<HashMap<&'static str, Vec<Value>>, String>> = LazyLock::new(|| {
    let content = default_dndsu_2014_content().map_err(|error| error.to_string())?;
    let monsters = content.get("monsters").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    Ok(ENCOUNTER_THEMES.iter().map(|theme| (*theme, classic_monsters_for_theme(monsters, theme))).collect())
});

/// `classicMonstersForTheme(theme)`: записи MM14 темы — по слагу состава SRD
/// (с псевдонимами), по типу существа, размеру и местам обитания.
fn classic_monsters_for_theme(monsters: &[Value], theme: &str) -> Vec<Value> {
    let alias = |slug: &'static str| match slug {
        "goblin-minion" | "goblin-warrior" => "goblin",
        "gnoll-warrior" => "gnoll",
        "warrior-veteran" => "veteran",
        other => other,
    };
    let mut slugs: HashSet<&str> = theme_roster(theme).unwrap_or_default().into_iter().map(|id| alias(slug_of(id))).collect();
    if theme == "law" {
        slugs.extend(["guard", "veteran"]);
    }
    if theme == "cult" {
        slugs.extend(["cultist", "cult-fanatic", "acolyte"]);
    }
    let habitats = |record: &Value, wanted: &[&str]| {
        record.get("habitats").and_then(Value::as_array).is_some_and(|habitats| habitats.iter().any(|habitat| habitat.as_str().is_some_and(|habitat| wanted.contains(&habitat))))
    };
    let creature_type = |record: &Value| record.get("creature_type").and_then(Value::as_str).map(str::to_string);
    monsters
        .iter()
        .filter(|record| {
            let id = js::s(record.get("id"));
            if theme == "generic" || slugs.contains(slug_of(&id)) {
                return true;
            }
            let kind = creature_type(record);
            match theme {
                "undead" | "crypt" => kind.as_deref() == Some("undead"),
                "beasts" => kind.as_deref() == Some("beast"),
                "vermin" => kind.as_deref() == Some("beast") && matches!(record.get("size").and_then(Value::as_str), Some("tiny" | "small")),
                "cave" => habitats(record, &["cave", "underdark"]),
                "wilderness" => kind.as_deref() != Some("humanoid") && habitats(record, &["forest", "grassland", "hill", "mountain"]),
                _ => false,
            }
        })
        .cloned()
        .collect()
}

/// Предложение встречи.
pub struct EncounterAssembler;

impl EncounterAssembler {
    /// `new EncounterAssembler().assemble(input)`.
    pub fn assemble(&self, input: Option<&Value>) -> Result<Value, AssembleFailure> {
        let validated = validate_input(input)?;
        let proposal_hash = digest(&format!("{ENCOUNTER_PROPOSAL_VERSION}\u{0}{}", validated.canonical()));
        // Подрайон выводится из проверенного входа, а не принимается извне:
        // иначе клетку появления можно было бы подсказать запросом.
        let bounds = spawn_bounds(&validated.cells, &validated.party);
        let available = safe_placement_cells(&validated.cells, &validated.party, bounds.as_ref());
        if available.is_empty() {
            return Err(EncounterAssemblyError::new("Нет безопасных клеток для размещения противников", "NO_SAFE_PLACEMENT_CELLS").into());
        }
        if validated.classic {
            return assemble_classic(&validated, &proposal_hash, &available);
        }
        assemble_srd(&validated, &proposal_hash, &available)
    }
}

/// `assembleEncounter(input)`.
pub fn assemble_encounter(input: Option<&Value>) -> Result<Value, AssembleFailure> {
    EncounterAssembler.assemble(input)
}

fn is_no_safe_placement(error: &EncounterAssemblyError) -> bool {
    error.code == "NO_SAFE_PLACEMENT_CELLS"
}

fn with_placements(prototypes: Vec<Value>, placements: &[(i64, i64)]) -> Vec<Value> {
    prototypes
        .into_iter()
        .zip(placements)
        .map(|(mut enemy, (x, y))| {
            if let Some(map) = enemy.as_object_mut() {
                map.insert("x".into(), Value::from(*x));
                map.insert("y".into(), Value::from(*y));
            }
            enemy
        })
        .collect()
}

fn assemble_srd(validated: &Validated, proposal_hash: &str, available: &[&Cell]) -> Result<Value, AssembleFailure> {
    let srd_budget: i64 = validated.party.iter().map(|member| XP_BUDGET_PER_CHARACTER[(member.level - 1) as usize][srd_difficulty(validated.difficulty)]).sum();
    // Умножение — единственное отличие смертельного тира от high, и оно
    // серверное: таблица SRD остаётся нетронутой.
    let budget_xp = if validated.difficulty == DEADLY_DIFFICULTY { srd_budget * DEADLY_BUDGET_MULTIPLIER } else { srd_budget };
    let quantity_cap = ENCOUNTER_ASSEMBLER_LIMITS
        .maximum_creatures
        .min(ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures_per_character * validated.party.len())
        .min(available.len());
    let roster = theme_roster(validated.theme).unwrap_or_default();
    let mut allocation = spend_budget(&roster, budget_xp, quantity_cap, proposal_hash);
    if allocation.stat_block_ids.is_empty() {
        return Err(EncounterAssemblyError::new("Бюджет не позволяет собрать столкновение выбранной темы", "BUDGET_CANNOT_FUND_ENCOUNTER").into());
    }
    let proposal_id = format!("encounter-proposal-{}", &proposal_hash[..24]);
    let candidates = deterministic_order(available, proposal_hash, "placement");
    let build = |ids: &[&'static str]| -> Result<Vec<Value>, AssembleFailure> {
        let mut counts: HashMap<&str, usize> = HashMap::new();
        ids.iter()
            .enumerate()
            .map(|(index, id)| {
                let ordinal = counts.get(id).copied().unwrap_or(0) + 1;
                counts.insert(id, ordinal);
                enemy_from(id, (0, 0), proposal_hash, index, ordinal, &proposal_id)
            })
            .collect()
    };
    let mut prototypes = build(&allocation.stat_block_ids)?;
    let placements = match deterministic_enemy_placements(&validated.cells, &validated.party, &prototypes, &candidates) {
        Ok(placements) => placements,
        Err(error) if is_no_safe_placement(&error) => {
            // Узкое поле может вместить двенадцать одноклеточных существ, хотя
            // план опыта содержит крупных: состав пересобирается в том же
            // бюджете с тем же числом, если у темы есть одноклеточный ростер.
            let one_cell: Vec<&'static str> = roster.iter().copied().filter(|id| footprint_metadata_for_size(srd_size(id).map(Value::from).as_ref()).size == 1).collect();
            let fallback = spend_budget(&one_cell, budget_xp, quantity_cap, proposal_hash);
            if fallback.stat_block_ids.len() < prototypes.len() {
                return Err(error.into());
            }
            allocation = fallback;
            prototypes = build(&allocation.stat_block_ids)?;
            deterministic_enemy_placements(&validated.cells, &validated.party, &prototypes, &candidates)?
        }
        Err(error) => return Err(error.into()),
    };
    let enemies = with_placements(prototypes, &placements);
    let spent_xp = allocation.spent_xp;
    let mut proposal = Map::new();
    proposal.insert("proposal_id".into(), Value::from(proposal_id));
    proposal.insert("version".into(), Value::from(ENCOUNTER_PROPOSAL_VERSION));
    proposal.insert("difficulty".into(), Value::from(validated.difficulty));
    // Ярлык едет рядом с самим уровнем: столу показывают его, а не бюджет.
    proposal.insert("difficulty_label".into(), difficulty_label_value(validated.difficulty));
    proposal.insert("theme".into(), Value::from(validated.theme));
    proposal.insert("xp_budget".into(), Value::from(budget_xp));
    proposal.insert("xp_spent".into(), Value::from(spent_xp));
    proposal.insert(
        "threat".into(),
        json!({
            "budget_xp": budget_xp,
            "spent_xp": spent_xp,
            "unspent_xp": budget_xp - spent_xp,
            "utilization_bps": js::num((spent_xp as f64 * 10_000.0 / budget_xp as f64).floor()),
            "quantity": enemies.len(),
            "quantity_cap": quantity_cap,
        }),
    );
    proposal.insert("enemies".into(), Value::Array(enemies));
    proposal.insert("source".into(), SRD_5_2_1_SOURCE.clone());
    Ok(Value::Object(proposal))
}

fn roster_for(records: &[Value], validated: &Validated, proposal_hash: &str, quantity_cap: usize) -> Result<EncounterRoster, EncounterMathError> {
    let levels: Vec<Value> = validated.party.iter().map(|member| Value::from(member.level)).collect();
    let seed = Value::from(proposal_hash);
    let maximum = Value::from(quantity_cap);
    select_encounter_roster(RosterRequest { records, party_levels: &levels, difficulty: validated.difficulty, seed: Some(&seed), maximum_creatures: Some(&maximum) })
}

fn assemble_classic(validated: &Validated, proposal_hash: &str, available: &[&Cell]) -> Result<Value, AssembleFailure> {
    let by_theme = CLASSIC_BY_THEME.as_ref().map_err(|error| AssembleFailure::Content(error.clone()))?;
    let content = default_dndsu_2014_content().map_err(|error| AssembleFailure::Content(error.to_string()))?;
    let quantity_cap = ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures.min(validated.party.len() * 2).min(available.len());
    let records = by_theme.get(validated.theme).map(Vec::as_slice).unwrap_or(&[]);
    let mut selection = roster_for(records, validated, proposal_hash, quantity_cap)?;
    let proposal_id = format!("encounter-proposal-{}", &proposal_hash[..24]);
    let build = |selected: &[Value]| -> Result<Vec<Value>, AssembleFailure> {
        let mut counts: HashMap<String, usize> = HashMap::new();
        let origin = json!({ "x": 0, "y": 0 });
        selected
            .iter()
            .enumerate()
            .map(|(index, record)| {
                let record_id = js::s(record.get("id"));
                let ordinal = counts.get(&record_id).copied().unwrap_or(0) + 1;
                counts.insert(record_id.clone(), ordinal);
                let mut enemy = enemy_from_2014(record, Some(&origin), index as f64);
                let id = enemy_id(proposal_hash, slug_of(&record_id), index);
                if let Some(map) = enemy.as_object_mut() {
                    map.insert("footprint".into(), footprint_metadata_for_size(record.get("size")).to_value());
                    map.insert("id".into(), Value::from(id.as_str()));
                    map.insert("name".into(), Value::from(format!("{} {ordinal}", js::string(record.get("name_ru")))));
                }
                // `block: enemy` — запись до инвентаря; он встаёт последним полем.
                let stat_block_id = record.get("id").cloned().unwrap_or(Value::Null);
                let (loadout, mut enemy) = loadout_for(stat_block_id, enemy, &id, proposal_hash, &proposal_id)?;
                if let Some(map) = enemy.as_object_mut() {
                    map.insert("loadout".into(), loadout);
                }
                Ok(enemy)
            })
            .collect()
    };
    let mut prototypes = build(&selection.records)?;
    let candidates = deterministic_order(available, proposal_hash, "placement");
    let placements = match deterministic_enemy_placements(&validated.cells, &validated.party, &prototypes, &candidates) {
        Ok(placements) => placements,
        Err(error) if is_no_safe_placement(&error) => {
            let small: Vec<Value> = records.iter().filter(|record| footprint_metadata_for_size(record.get("size")).size == 1).cloned().collect();
            let fallback = roster_for(&small, validated, proposal_hash, quantity_cap)?;
            if fallback.records.len() < prototypes.len() {
                return Err(error.into());
            }
            selection = fallback;
            prototypes = build(&selection.records)?;
            deterministic_enemy_placements(&validated.cells, &validated.party, &prototypes, &candidates)?
        }
        Err(error) => return Err(error.into()),
    };
    let enemies = with_placements(prototypes, &placements);
    let budget_xp = if selection.interval.upper.is_finite() { selection.interval.upper } else { selection.target_adjusted_xp };
    let adjusted = selection.adjusted_xp;
    let mut proposal = Map::new();
    proposal.insert("proposal_id".into(), Value::from(proposal_id));
    proposal.insert("version".into(), Value::from(ENCOUNTER_PROPOSAL_VERSION));
    proposal.insert("difficulty".into(), Value::from(validated.difficulty));
    proposal.insert("difficulty_label".into(), difficulty_label_value(validated.difficulty));
    proposal.insert("theme".into(), Value::from(validated.theme));
    proposal.insert("xp_budget".into(), js::num(budget_xp));
    proposal.insert("xp_spent".into(), js::num(adjusted));
    proposal.insert(
        "threat".into(),
        json!({
            "budget_xp": js::num(budget_xp),
            "spent_xp": js::num(adjusted),
            "raw_xp": js::num(selection.raw_xp),
            "multiplier": js::num(selection.multiplier),
            "unspent_xp": js::num(0.0_f64.max(budget_xp - adjusted)),
            "utilization_bps": js::num((adjusted * 10_000.0 / budget_xp.max(1.0)).floor()),
            "quantity": enemies.len(),
            "quantity_cap": quantity_cap,
        }),
    );
    proposal.insert("enemies".into(), Value::Array(enemies));
    proposal.insert(
        "source".into(),
        json!({
            "title": "Бестиарий MM14 по dnd.su",
            "ruleset_id": "dnd_5e_2014",
            "version": content.get("manifest").and_then(|manifest| manifest.get("version")).cloned().unwrap_or(Value::Null),
            "url": "https://5e14.dnd.su/bestiary/",
        }),
    );
    Ok(Value::Object(proposal))
}

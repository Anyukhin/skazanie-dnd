//! Перенос `server/combat-spells.mjs`: карточки заклинаний героя и существа
//! из каталога dnd.su (`data/dndsu-spells-0-6.json`) с серверными правками
//! механики (`data/dndsu-spell-mechanics-overrides.json`).
//!
//! - Статус механики карточки: `verified` / `partial` / `heuristic` /
//!   `ruling-only`; без правки карточка — `heuristic` и блокируется движком.
//! - Редакция кампании: для D&D 2014 правка `mechanics2014` накладывается
//!   поверх общей, длительность эффекта разбирается из метаданных источника;
//!   прочие редакции теряют поля, которые существуют только в 2014
//!   (`components`, `areaGeometryVersion`, `mechanics2014`).
//! - Заклинатель класса: ячейки, заговоры, известные и подготовленные
//!   заклинания по уровню 1–12, договор колдуна, заклинания домена, врождённые
//!   заклинания вида и черт.
//! - Заклинатель из стат-блока существа: свой блок со СЛ и бонусом атаки,
//!   общие ячейки 2014 или «X в день».
//!
//! Карточки — `serde_json::Value` той же формы и с тем же порядком ключей,
//! что у JS: по ним считается проекция игроку.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::fancy_regex::Regex;
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, re, text};
use sk_ruleset::character_creation_feats::is_class_spell_available;
use sk_ruleset::character_progression::normalized_selected_feature_ids;

use crate::jsv::{self, array, defined, is_num, is_str, nullish, num, prop, table_index};

const DEFAULT_PARTIAL_NOTE: &str = "Сервер исполняет формализованную часть карточки; полный набор исключений и взаимодействий ещё не подтверждён.";
const DEFAULT_RULING_NOTE: &str = "Карточка известна каталогу, но для её эффекта ещё нет исполняемого серверного решения.";
const DND_2014_RULESET_ID: &str = "dnd_5e_2014";

/// Политика срока эффектов 2014, выведенного из длительности карточки.
pub const DND_2014_TIMED_BUFF_EXPIRY_POLICY: &str = "dnd2014-timed-buff/v1";

/// Применение «неограниченно» в стат-блоке.
pub const MONSTER_SPELL_AT_WILL: &str = "at-will";

/// Маркер потраченного применения: `monster-spell-used:<spell>#<n>`.
pub const MONSTER_SPELL_USE_CONDITION_PREFIX: &str = "monster-spell-used:";

static PAYLOAD: LazyLock<Value> = LazyLock::new(|| jsv::embedded_json(include_str!("../../../../data/dndsu-spells-0-6.json")));
static OVERRIDE_PAYLOAD: LazyLock<Value> = LazyLock::new(|| jsv::embedded_json(include_str!("../../../../data/dndsu-spell-mechanics-overrides.json")));

/// Каталог с наложенными правками механики (`SPELLS`).
static SPELLS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    let overrides = OVERRIDE_PAYLOAD.get("spells");
    array(PAYLOAD.get("spells")).iter().map(|spell| merge_override(spell, overrides)).collect()
});

/// `SPELLS_BY_ID`: индекс в [`SPELLS`]; при повторе id побеждает последний.
static SPELLS_BY_ID: LazyLock<HashMap<String, usize>> = LazyLock::new(|| {
    let mut by_id = HashMap::new();
    for (index, spell) in SPELLS.iter().enumerate() {
        by_id.insert(js::s(spell.get("id")), index);
    }
    by_id
});

/// Шаблоны карточек по редакциям: прочие редакции и D&D 2014.
static TEMPLATES_DEFAULT: LazyLock<Vec<Value>> = LazyLock::new(|| SPELLS.iter().map(|spell| spell_for_ruleset(spell, "")).collect());
static TEMPLATES_2014: LazyLock<Vec<Value>> = LazyLock::new(|| SPELLS.iter().map(|spell| spell_for_ruleset(spell, DND_2014_RULESET_ID)).collect());

fn merge_override(spell: &Value, overrides: Option<&Value>) -> Value {
    let id = js::s(spell.get("id"));
    let mechanics_override = prop(overrides, &id).filter(|value| js::truthy(Some(value)));
    let mechanics_support = match defined(prop(mechanics_override, "mechanicsSupport")) {
        Some(value) => value.clone(),
        None => Value::from(if mechanics_override.is_some() { "partial" } else { "heuristic" }),
    };
    let mut card = spell.as_object().cloned().unwrap_or_default();
    jsv::spread_into(&mut card, mechanics_override);
    match spell.get("description") {
        Some(description) => {
            card.insert("description".into(), description.clone());
        }
        None => {
            card.shift_remove("description");
        }
    }
    let accuracy = match defined(prop(mechanics_override, "mechanicsAccuracy")) {
        Some(value) => value.clone(),
        None => Value::from(if mechanics_override.is_some() { "verified-dndsu" } else { "heuristic" }),
    };
    card.insert("mechanicsAccuracy".into(), accuracy);
    card.insert("mechanicsSupport".into(), mechanics_support.clone());
    let support = mechanics_support.as_str();
    if js::truthy(prop(mechanics_override, "supportNote")) || support == Some("partial") || support == Some("ruling-only") {
        let note = match defined(prop(mechanics_override, "supportNote")) {
            Some(note) => note.clone(),
            None => Value::from(if support == Some("partial") { DEFAULT_PARTIAL_NOTE } else { DEFAULT_RULING_NOTE }),
        };
        card.insert("supportNote".into(), note);
    }
    Value::Object(card)
}

/// `rulesetIdOf(options)`: строка, `{ rulesetId }` или `{ ruleset_id }`,
/// иначе `srd_5_2_1`.
pub fn ruleset_id_of(options: Option<&Value>) -> String {
    match options {
        Some(Value::String(text)) => text.clone(),
        other => match nullish(prop(other, "rulesetId"), prop(other, "ruleset_id")) {
            Some(value) if !value.is_null() => jsv::string(Some(value)),
            _ => "srd_5_2_1".into(),
        },
    }
}

/// Карточка в редакции кампании (`spellForRuleset`).
fn spell_for_ruleset(spell: &Value, ruleset_id: &str) -> Value {
    let Some(source) = spell.as_object() else {
        return spell.clone();
    };
    if ruleset_id != DND_2014_RULESET_ID {
        let mut legacy = source.clone();
        for key in ["components", "areaGeometryVersion", "mechanics2014"] {
            legacy.shift_remove(key);
        }
        return Value::Object(legacy);
    }
    let mut card = source.clone();
    // Проверенная редакция не меняет профиль другой редакции. Это часть того
    // же server-owned override, а не отдельный каталог или клиентское решение.
    if js::truthy(source.get("mechanics2014")) {
        jsv::spread_into(&mut card, source.get("mechanics2014"));
    }
    let id = js::s(card.get("id"));
    match id.as_str() {
        "true-strike" => {
            jsv::spread_into(
                &mut card,
                Some(&json!({
                    "target": "creature",
                    "requiresCombatAgainstHostile": false,
                    "conditionDuration": "source-turns:2",
                    "conditionDurationSecondsOutsideCombat": 6,
                    "supportNote": "D&D 2014: выберите видимую цель в 30 футах. Преимущество получает первая атака по этой цели на следующем ходу заклинателя, пока он держит концентрацию.",
                })),
            );
            Value::Object(card)
        }
        "blade-ward" => {
            jsv::spread_into(
                &mut card,
                Some(&json!({
                    "conditionDuration": "source-turns:2",
                    "conditionDurationSecondsOutsideCombat": 6,
                    "supportNote": "D&D 2014: сопротивление дробящему, колющему и рубящему урону атак оружием до конца следующего хода заклинателя.",
                })),
            );
            Value::Object(card)
        }
        "hex" => {
            jsv::spread_into(
                &mut card,
                Some(&json!({
                    "spellOptions": ["str", "dex", "con", "int", "wis", "cha"],
                    "supportNote": "D&D 2014: выбранная характеристика получает помеху только на проверки; спасброски не меняются. Попадания заклинателя добавляют 1к6 некротического урона. Перенос после падения цели до 0 хитов и взаимодействие со «Снятием проклятия» ещё не исполняются.",
                })),
            );
            timed_condition_for_dnd2014(Value::Object(card))
        }
        "resistance" => {
            jsv::spread_into(
                &mut card,
                Some(&json!({
                    "spellOptions": [],
                    "concentration": true,
                    "durationRounds": 10,
                    "resistanceSavingThrow": true,
                    "resistanceBonusExpression": "1d4",
                    "description": "Коснитесь согласного существа. Один раз до окончания заклинания цель может добавить 1к4 к одному спасброску по своему выбору, после чего заклинание заканчивается.",
                    "supportNote": "Вариант D&D 2014: концентрация до 1 минуты; цель сама выбирает один спасбросок для бонуса 1к4.",
                })),
            );
            Value::Object(card)
        }
        _ => timed_condition_for_dnd2014(Value::Object(card)),
    }
}

/// `timedConditionForDnd2014(spell)`: разбирается только однозначная
/// длительность метаданных источника, не описание эффекта. Особые сроки хода,
/// компоненты и отдельные обработчики остаются явными.
fn timed_condition_for_dnd2014(spell: Value) -> Value {
    let field = |key: &str| spell.get(key);
    let support_ok = ["partial", "verified"].iter().any(|status| is_str(field("mechanicsSupport"), status));
    let kind_ok = ["buff", "utility", "save", "debuff", "area-save", "area-damage"].iter().any(|kind| is_str(field("kind"), kind));
    let has_conditions = conditions_length_truthy(field("conditions"));
    if !support_ok
        || !kind_ok
        || !has_conditions
        || js::truthy(field("conditionDuration"))
        || js::truthy(field("conditionDurationMinutes"))
        || js::truthy(field("conditionDurationSeconds"))
        || js::truthy(field("createsAreaEffect"))
        || js::truthy(field("temporaryHpAbilityModifier"))
        || js::truthy(field("continuationDurationSeconds"))
        || ["sunbeam", "flesh-to-stone", "banishment"].iter().any(|id| is_str(field("id"), id))
    {
        return spell;
    }
    let duration = text::trim(&text::lower(&js::s(field("duration")))).to_string();
    let pattern = re!(r"^(?:концентрация,\s*вплоть до\s*)?(\d+)\s+(раунд[а-яё]*|минут[а-яё]*|час[а-яё]*|день|дня|дней)$", "u");
    let Ok(Some(captures)) = pattern.captures(&duration) else {
        return spell;
    };
    let amount = captures.get(1).map_or("", |m| m.as_str());
    let unit = captures.get(2).map_or("", |m| m.as_str());
    // Срок «1 раунд» у атаки/помехи обычно задаётся относительно хода источника.
    if !["buff", "utility"].iter().any(|kind| is_str(field("kind"), kind)) && unit.starts_with("раунд") {
        return spell;
    }
    let seconds_per_unit = if unit.starts_with("раунд") {
        6.0
    } else if unit.starts_with("минут") {
        60.0
    } else if unit.starts_with("час") {
        3_600.0
    } else {
        86_400.0
    };
    let seconds = js::parse_number(amount) * seconds_per_unit;
    if !jsv::is_safe_integer(seconds) || seconds <= 0.0 {
        return spell;
    }
    let id = js::s(field("id"));
    let mut card = spell.as_object().cloned().unwrap_or_default();
    card.insert("conditionDurationSeconds".into(), num(seconds));
    card.insert("conditionExpiryPolicy".into(), Value::from(DND_2014_TIMED_BUFF_EXPIRY_POLICY));
    let by_slot = match id.as_str() {
        "hex" | "hunter-s-mark" => Some(json!({ "3": 28_800, "4": 28_800, "5": 86_400, "6": 86_400 })),
        "dominate-beast" => Some(json!({ "5": 600, "6": 3_600 })),
        "dominate-person" => Some(json!({ "6": 600 })),
        _ => None,
    };
    if let Some(by_slot) = by_slot {
        card.insert("conditionDurationSecondsBySlotLevel".into(), by_slot);
    }
    Value::Object(card)
}

/// `!spell.conditions?.length` наоборот: у списка или строки есть длина.
fn conditions_length_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Object(map)) => js::truthy(map.get("length")),
        other => jsv::length(other).is_some_and(|length| length > 0),
    }
}

/// Шаблон карточки редакции (`rulesetSpellTemplate`): считается один раз на
/// пару «заклинание + редакция».
fn ruleset_template(index: usize, ruleset_id: &str) -> &'static Value {
    if ruleset_id == DND_2014_RULESET_ID {
        &TEMPLATES_2014[index]
    } else {
        &TEMPLATES_DEFAULT[index]
    }
}

fn spell_index(id: &str) -> Option<usize> {
    SPELLS_BY_ID.get(id).copied()
}

/// Прогрессия ячеек заклинателя класса.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Progression {
    Full,
    Half,
    Pact,
}

/// Профиль заклинателя класса (`casterProfile`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CasterProfile {
    key: &'static str,
    ability: &'static str,
    progression: Progression,
}

const fn profile(key: &'static str, ability: &'static str, progression: Progression) -> CasterProfile {
    CasterProfile { key, ability, progression }
}

const CLERIC: CasterProfile = profile("cleric", "wis", Progression::Full);
const DRUID: CasterProfile = profile("druid", "wis", Progression::Full);
const BARD: CasterProfile = profile("bard", "cha", Progression::Full);
const SORCERER: CasterProfile = profile("sorcerer", "cha", Progression::Full);
const WARLOCK: CasterProfile = profile("warlock", "cha", Progression::Pact);
const WIZARD: CasterProfile = profile("wizard", "int", Progression::Full);
const RANGER: CasterProfile = profile("ranger", "wis", Progression::Half);
const PALADIN: CasterProfile = profile("paladin", "cha", Progression::Half);

const FULL_CASTER_SLOTS: [&[i64]; 13] = [
    &[],
    &[2],
    &[3],
    &[4, 2],
    &[4, 3],
    &[4, 3, 2],
    &[4, 3, 3],
    &[4, 3, 3, 1],
    &[4, 3, 3, 2],
    &[4, 3, 3, 3, 1],
    &[4, 3, 3, 3, 2],
    &[4, 3, 3, 3, 2, 1],
    &[4, 3, 3, 3, 2, 1],
];

const HALF_CASTER_SLOTS: [&[i64]; 13] = [
    &[],
    &[],
    &[2],
    &[3],
    &[3],
    &[4, 2],
    &[4, 2],
    &[4, 3],
    &[4, 3],
    &[4, 3, 2],
    &[4, 3, 2],
    &[4, 3, 3],
    &[4, 3, 3],
];

/// Договор колдуна: `(ячеек, круг)`; нулевой уровень — `null`.
const WARLOCK_PACT: [Option<(i64, i64)>; 13] = [
    None,
    Some((1, 1)),
    Some((2, 1)),
    Some((2, 2)),
    Some((2, 2)),
    Some((2, 3)),
    Some((2, 3)),
    Some((2, 4)),
    Some((2, 4)),
    Some((2, 5)),
    Some((2, 5)),
    Some((3, 5)),
    Some((3, 5)),
];

fn cantrips_table(key: &str) -> Option<[i64; 13]> {
    Some(match key {
        "bard" | "druid" | "warlock" => [0, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4],
        "cleric" | "wizard" => [0, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5],
        "sorcerer" => [0, 4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6],
        _ => return None,
    })
}

fn spells_known_table(key: &str) -> Option<[i64; 13]> {
    Some(match key {
        "bard" => [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 15],
        "ranger" => [0, 0, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7],
        "sorcerer" => [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12],
        "warlock" => [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11],
        _ => return None,
    })
}

fn table_at<T: Copy>(table: &[T], level: f64) -> Option<T> {
    table_index(level).and_then(|index| table.get(index).copied())
}

/// `roleText(actor)`: роль, класс и `characterClass` одной строкой в нижнем регистре.
fn role_text(actor: Option<&Value>) -> String {
    let part = |key: &str| js::s(prop(actor, key));
    text::lower(&format!("{} {} {}", part("role"), part("class"), part("characterClass")))
}

/// `casterProfile(actor)`.
fn caster_profile(actor: Option<&Value>) -> Option<CasterProfile> {
    let explicit = text::lower(&js::s(nullish(prop(actor, "characterClass"), prop(actor, "class"))));
    match explicit.as_str() {
        "cleric" => return Some(CLERIC),
        "druid" => return Some(DRUID),
        "bard" => return Some(BARD),
        "sorcerer" => return Some(SORCERER),
        "warlock" => return Some(WARLOCK),
        "wizard" => return Some(WIZARD),
        "ranger" => return Some(RANGER),
        "paladin" => return Some(PALADIN),
        "barbarian" | "fighter" | "monk" | "rogue" => return None,
        _ => {}
    }
    let role = role_text(actor);
    let checks: [(&Regex, CasterProfile); 8] = [
        (re!(r"жрец|cleric", "u"), CLERIC),
        (re!(r"друид|druid", "u"), DRUID),
        (re!(r"бард|bard", "u"), BARD),
        (re!(r"чарод|sorcer", "u"), SORCERER),
        (re!(r"колдун|warlock", "u"), WARLOCK),
        (re!(r"волшеб|wizard|маг\b", "u"), WIZARD),
        (re!(r"следопыт|ranger", "u"), RANGER),
        (re!(r"паладин|paladin", "u"), PALADIN),
    ];
    checks.into_iter().find(|(pattern, _)| text::test(pattern, &role)).map(|(_, profile)| profile)
}

/// `boundedLevel(actor)`: уровень 1–12; дробный уровень JS сохраняет.
fn bounded_level(actor: Option<&Value>) -> f64 {
    jsv::max2(1.0, jsv::min2(12.0, jsv::number_or(prop(actor, "level"), 1.0)))
}

fn maximum_spell_level(profile: CasterProfile, level: f64) -> i64 {
    match profile.progression {
        Progression::Full => table_at(&FULL_CASTER_SLOTS, level).map_or(0, |slots| slots.len() as i64),
        Progression::Half => table_at(&HALF_CASTER_SLOTS, level).map_or(0, |slots| slots.len() as i64),
        Progression::Pact => {
            if level >= 11.0 {
                6
            } else {
                table_at(&WARLOCK_PACT, level).flatten().map_or(0, |(_, slot)| slot)
            }
        }
    }
}

fn slot_resource_for_profile(profile: CasterProfile, spell: &Value) -> Value {
    if is_num(spell.get("level"), 0.0) {
        return Value::Null;
    }
    if profile.progression == Progression::Pact {
        return Value::from(if is_num(spell.get("level"), 6.0) { "mystic_arcanum_6" } else { "pact_slots" });
    }
    Value::from(format!("spell_slots_{}", jsv::string(spell.get("level"))))
}

/// Фиксированный круг специального ресурса. Rules Engine использует этот
/// помощник, чтобы не копировать таблицу pact magic в отдельном валидаторе.
/// `None` означает обычную ячейку, которую можно выбрать по запросу игрока
/// (`null` в JS); `Some(Value::Null)` — `NaN` из мусорного уровня.
pub fn fixed_spell_slot_level_for(actor: Option<&Value>, spell: Option<&Value>) -> Option<Value> {
    let spell = spell.filter(|spell| js::truthy(Some(spell)))?;
    let level = spell.get("level");
    if is_num(level, 0.0) {
        return None;
    }
    let resource = js::s(spell.get("slotResource"));
    if resource == "mystic_arcanum_6" {
        return Some(Value::from(6));
    }
    if resource == "pact_slots" {
        if caster_profile(actor).is_some_and(|profile| profile.progression == Progression::Pact) {
            return match table_at(&WARLOCK_PACT, bounded_level(actor)).flatten() {
                Some((_, slot)) => Some(Value::from(slot)),
                None => level.cloned(),
            };
        }
        return level.cloned();
    }
    if resource.starts_with("species_spell_") {
        let base = js::number(level);
        let cast = js::number(spell.get("innateCastLevel"));
        let cast = if cast == 0.0 || cast.is_nan() { base } else { cast };
        return Some(num(jsv::max2(base, cast)));
    }
    None
}

/// `selectedSpellIds(actor, camel, snake)`: выбор есть, если у героя есть
/// само поле, даже пустое.
fn selected_spell_ids(actor: Option<&Value>, camel: &str, snake: &str) -> Option<IndexSet<String>> {
    let map = actor.and_then(Value::as_object);
    let has_selection = map.is_some_and(|map| map.contains_key(camel) || map.contains_key(snake));
    if !has_selection {
        return None;
    }
    let source = nullish(prop(actor, camel), prop(actor, snake));
    Some(array(source).iter().map(|id| jsv::string(Some(id))).collect())
}

/// Правила выбора заклинаний класса (`spellSelectionRulesFor`).
#[derive(Clone, Debug, PartialEq)]
pub struct SpellSelectionRules {
    pub class_key: &'static str,
    /// `known`, `prepared` или `spellbook`.
    pub mode: &'static str,
    pub cantrips: f64,
    pub spells_known: f64,
    pub prepared_limit: f64,
    pub spellbook_minimum: f64,
    pub maximum_spell_level: i64,
}

impl SpellSelectionRules {
    /// Форма JS.
    pub fn to_value(&self) -> Value {
        json!({
            "classKey": self.class_key,
            "mode": self.mode,
            "cantrips": num(self.cantrips),
            "spellsKnown": num(self.spells_known),
            "preparedLimit": num(self.prepared_limit),
            "spellbookMinimum": num(self.spellbook_minimum),
            "maximumSpellLevel": self.maximum_spell_level,
        })
    }
}

/// Правила выбора заклинаний героя по классу и уровню; `None` — не заклинатель.
pub fn spell_selection_rules_for(actor: Option<&Value>) -> Option<SpellSelectionRules> {
    let profile = caster_profile(actor)?;
    let level = bounded_level(actor);
    let score = jsv::number_or(prop(prop(actor, "abilities"), profile.ability), 10.0);
    let modifier = ((score - 10.0) / 2.0).floor();
    let mode = if profile.key == "wizard" {
        "spellbook"
    } else if spells_known_table(profile.key).is_some() {
        "known"
    } else {
        "prepared"
    };
    let prepared_limit = if profile.key == "paladin" {
        if level < 2.0 {
            0.0
        } else {
            jsv::max2(1.0, (level / 2.0).floor() + modifier)
        }
    } else if mode == "prepared" || profile.key == "wizard" {
        jsv::max2(1.0, level + modifier)
    } else {
        0.0
    };
    Some(SpellSelectionRules {
        class_key: profile.key,
        mode,
        cantrips: cantrips_table(profile.key).and_then(|table| table_at(&table, level)).unwrap_or(0) as f64,
        spells_known: spells_known_table(profile.key).and_then(|table| table_at(&table, level)).unwrap_or(0) as f64,
        prepared_limit,
        spellbook_minimum: if profile.key == "wizard" { 6.0 + (level - 1.0) * 2.0 } else { 0.0 },
        maximum_spell_level: maximum_spell_level(profile, level),
    })
}

/// Число элементов `slice(0, Math.max(0, maximum))`.
fn slice_count(length: usize, maximum: f64) -> usize {
    let maximum = jsv::max2(0.0, maximum);
    if maximum.is_nan() {
        return 0;
    }
    if maximum >= length as f64 {
        length
    } else {
        maximum.trunc() as usize
    }
}

struct Selection {
    known: Option<IndexSet<String>>,
    prepared: Option<IndexSet<String>>,
}

fn bounded_selection(actor: Option<&Value>, profile: CasterProfile, rules: &SpellSelectionRules) -> Selection {
    let mut by_id: HashMap<String, &Value> = HashMap::new();
    for spell in SPELLS.iter() {
        let level = spell.get("level");
        if is_class_spell_available(Some(spell), profile.key, actor) && (is_num(level, 0.0) || js::number(level) <= rules.maximum_spell_level as f64) {
            by_id.insert(js::s(spell.get("id")), spell);
        }
    }
    let raw_known = selected_spell_ids(actor, "knownSpellIds", "known_spell_ids");
    let raw_prepared = selected_spell_ids(actor, "preparedSpellIds", "prepared_spell_ids");
    let take = |source: &Option<IndexSet<String>>, predicate: &dyn Fn(Option<&Value>) -> bool, maximum: f64| -> Option<IndexSet<String>> {
        let source = source.as_ref()?;
        let filtered: Vec<&String> = source.iter().filter(|id| predicate(by_id.get(id.as_str()).copied())).collect();
        let keep = slice_count(filtered.len(), maximum);
        Some(filtered.into_iter().take(keep).cloned().collect())
    };
    let cantrips = take(&raw_known, &|spell| is_num(spell.and_then(|spell| spell.get("level")), 0.0), rules.cantrips);
    let known_maximum = match rules.mode {
        "known" => rules.spells_known,
        "spellbook" => rules.spellbook_minimum,
        _ => f64::INFINITY,
    };
    let leveled_known = take(&raw_known, &|spell| spell.is_some_and(|spell| js::number(spell.get("level")) > 0.0), known_maximum);
    let known: Option<IndexSet<String>> = raw_known.as_ref().map(|_| cantrips.iter().flatten().chain(leveled_known.iter().flatten()).cloned().collect());
    let prepared = take(
        &raw_prepared,
        &|spell| {
            spell.is_some_and(|spell| {
                js::number(spell.get("level")) > 0.0 && (rules.mode != "spellbook" || known.as_ref().is_none_or(|known| known.contains(&js::s(spell.get("id")))))
            })
        },
        rules.prepared_limit,
    );
    Selection { known, prepared }
}

/// Нормализованный выбор заклинаний героя: `{ knownSpellIds?, preparedSpellIds? }`.
/// Поле отсутствует, если у героя нет соответствующего выбора (`undefined` в JS).
pub fn normalized_spell_selections_for(actor: Option<&Value>) -> Value {
    let Some(profile) = caster_profile(actor) else {
        return json!({ "knownSpellIds": [], "preparedSpellIds": [] });
    };
    let Some(rules) = spell_selection_rules_for(actor) else {
        return json!({ "knownSpellIds": [], "preparedSpellIds": [] });
    };
    let selection = bounded_selection(actor, profile, &rules);
    let mut result = Map::new();
    if let Some(known) = selection.known {
        result.insert("knownSpellIds".into(), jsv_strings(known));
    }
    if let Some(prepared) = selection.prepared {
        result.insert("preparedSpellIds".into(), jsv_strings(prepared));
    }
    Value::Object(result)
}

fn jsv_strings(items: impl IntoIterator<Item = String>) -> Value {
    Value::Array(items.into_iter().map(Value::String).collect())
}

/// `domainSpellIdsFor(actor)`: заклинания домена, всегда подготовленные.
fn domain_spell_ids_for(actor: Option<&Value>) -> IndexSet<String> {
    let benefits = defined(prop(actor, "creationBenefits"));
    let normalize = |id: Option<&Value>| text::lower(&jsv::s(defined(id)).replace('_', "-"));
    let class_key = text::lower(&js::s(nullish(nullish(prop(actor, "characterClass"), prop(actor, "class")), jsv::path(benefits, &["class", "class_key"]))));
    let subclass_id = text::lower(&js::s(nullish(nullish(jsv::path(benefits, &["class", "subclass", "id"]), prop(actor, "subclassId")), prop(actor, "subclass"))));
    let is_tempest = class_key == "cleric" && ["tempest", "cleric-domen-buri", "домен бури"].contains(&subclass_id.as_str());
    let mut ids: IndexSet<String> =
        array(prop(benefits, "domain_spells")).iter().map(|id| normalize(Some(id))).filter(|id| !id.is_empty() && (id != "destructive-wave" || is_tempest)).collect();
    if is_tempest {
        let by_level = defined(prop(benefits, "domain_spells_by_level"));
        let entries: Vec<(String, &Value)> = match by_level {
            Some(Value::Object(map)) => js::entries(map).into_iter().map(|(key, value)| (key.clone(), value)).collect(),
            Some(Value::Array(items)) => items.iter().enumerate().map(|(index, value)| (index.to_string(), value)).collect(),
            _ => Vec::new(),
        };
        for (level, spell_ids) in entries {
            if !text::test(re!(r"^\d+$", "u"), &level) {
                continue;
            }
            let Value::Array(spell_ids) = spell_ids else {
                continue;
            };
            for id in spell_ids {
                let normalized = normalize(Some(id));
                if !normalized.is_empty() {
                    ids.insert(normalized);
                }
            }
        }
    }
    ids
}

/// Бонус атаки заклинанием героя по характеристике заклинателя: модификатор
/// характеристики плюс бонус мастерства. Одна формула и для движка
/// (`CastSpell`), и для листа героя на панели стола.
pub fn hero_spell_attack_modifier(actor: Option<&Value>, ability: &str) -> i64 {
    let raw = js::number(prop(prop(actor, "abilities"), ability));
    let score = if jsv::is_safe_integer(raw) { raw } else { 10.0 };
    let proficiency = js::number(prop(actor, "proficiency"));
    let proficiency = if jsv::is_safe_integer(proficiency) { proficiency } else { 0.0 };
    (((score - 10.0) / 2.0).floor() + proficiency.max(0.0)) as i64
}

/// Сводка заклинателя класса для листа героя:
/// `{ ability, attack_bonus, save_dc }`; у класса без заклинаний — `None`.
pub fn hero_spellcasting_summary_for(actor: Option<&Value>) -> Option<Value> {
    let profile = caster_profile(actor)?;
    let attack_bonus = hero_spell_attack_modifier(actor, profile.ability);
    Some(json!({ "ability": profile.ability, "attack_bonus": attack_bonus, "save_dc": 8 + attack_bonus }))
}

/// Карточки заклинаний героя: классовые с подготовкой и ресурсом ячейки,
/// затем врождённые заклинания вида и черт.
pub fn combat_spells_for(actor: Option<&Value>, options: Option<&Value>) -> Vec<Value> {
    let ruleset_id = ruleset_id_of(options);
    let profile = caster_profile(actor);
    let level = bounded_level(actor);
    let mut by_id: IndexMap<String, Value> = IndexMap::new();
    if let (Some(profile), Some(rules)) = (profile, spell_selection_rules_for(actor)) {
        let maximum = maximum_spell_level(profile, level);
        let domain_spell_ids = domain_spell_ids_for(actor);
        let selection = bounded_selection(actor, profile, &rules);
        let invocations: Vec<String> = if profile.key == "warlock" { normalized_selected_feature_ids(actor) } else { Vec::new() };
        for (index, spell) in SPELLS.iter().enumerate() {
            let id = js::s(spell.get("id"));
            let spell_level = spell.get("level");
            let is_cantrip = is_num(spell_level, 0.0);
            if !((is_class_spell_available(Some(spell), profile.key, actor) || domain_spell_ids.contains(&id)) && (is_cantrip || js::number(spell_level) <= maximum as f64)) {
                continue;
            }
            let known_has = |known: &Option<IndexSet<String>>| known.as_ref().is_none_or(|known| known.contains(&id));
            let is_prepared = if domain_spell_ids.contains(&id) {
                true
            } else if is_cantrip {
                known_has(&selection.known)
            } else {
                match rules.mode {
                    "known" => known_has(&selection.known),
                    "spellbook" => known_has(&selection.known) && known_has(&selection.prepared),
                    _ => known_has(&selection.prepared),
                }
            };
            let slot_resource = slot_resource_for_profile(profile, spell);
            let mut slot_profile = spell.as_object().cloned().unwrap_or_default();
            slot_profile.insert("slotResource".into(), slot_resource.clone());
            let slot_level = fixed_spell_slot_level_for(actor, Some(&Value::Object(slot_profile))).or_else(|| spell_level.cloned());
            let mut card = ruleset_template(index, &ruleset_id).as_object().cloned().unwrap_or_default();
            // «Мистическое копьё» колдуна: Мистический заряд бьёт на 300 футов.
            if id == "eldritch-blast" && invocations.iter().any(|entry| entry == "eldritch-spear") {
                card.insert("range".into(), Value::from(300));
            }
            card.insert("slotResource".into(), slot_resource);
            insert_or_remove(&mut card, "slotLevel", slot_level);
            card.insert("spellcastingAbility".into(), Value::from(profile.ability));
            card.insert("spellcastingClass".into(), Value::from(profile.key));
            card.insert("prepared".into(), Value::Bool(is_prepared));
            by_id.insert(id, Value::Object(card));
        }
    }
    let mut innate_entries = jsv::spread_items(jsv::path(actor, &["speciesBenefits", "innate_spells"]).filter(|value| value.is_array()));
    innate_entries.extend(jsv::spread_items(prop(actor, "creationSpellGrants")));
    for entry in &innate_entries {
        let entry = Some(entry);
        let minimum = jsv::max2(1.0, jsv::number_or(prop(entry, "minimum_level"), 1.0));
        if !(level >= minimum) {
            continue;
        }
        let Some(index) = spell_index(&js::s(prop(entry, "id"))) else {
            continue;
        };
        let spell = &SPELLS[index];
        let uses = js::number(prop(entry, "uses"));
        let limited = uses.is_finite() && uses > 0.0;
        let base_level = js::number(spell.get("level"));
        let innate_cast_level = jsv::max2(base_level, jsv::number_or(prop(entry, "cast_level"), base_level));
        let slot_resource = if limited { Value::from(format!("species_spell_{}", js::s(spell.get("id")))) } else { Value::Null };
        let mut slot_profile = spell.as_object().cloned().unwrap_or_default();
        slot_profile.insert("slotResource".into(), slot_resource.clone());
        slot_profile.insert("innateCastLevel".into(), num(innate_cast_level));
        let slot_level = fixed_spell_slot_level_for(actor, Some(&Value::Object(slot_profile))).or_else(|| spell.get("level").cloned());
        let mut card = ruleset_template(index, &ruleset_id).as_object().cloned().unwrap_or_default();
        card.insert("prepared".into(), Value::Bool(true));
        card.insert("innateSpell".into(), Value::Bool(true));
        card.insert("innateCastLevel".into(), num(innate_cast_level));
        card.insert("spellcastingAbility".into(), Value::from(jsv::string(Some(defined(prop(entry, "ability")).unwrap_or(&Value::from("cha"))))));
        let class_key = prop(entry, "class_key");
        if js::truthy(class_key) {
            let class_key = jsv::string(class_key);
            card.insert("innateSpellcastingClass".into(), Value::from(class_key.clone()));
            if profile.is_some_and(|profile| profile.key == class_key) {
                card.insert("spellcastingClass".into(), Value::from(class_key));
            }
        }
        card.insert("slotResource".into(), slot_resource);
        insert_or_remove(&mut card, "slotLevel", slot_level);
        card.insert("source".into(), defined(prop(entry, "source")).cloned().unwrap_or_else(|| Value::from("species")));
        let id = js::s(spell.get("id"));
        let class_version = by_id.get(&id);
        let fallback = class_version.and_then(|version| {
            let prepared_not_false = !js::is_false(version.get("prepared"));
            (prepared_not_false && js::truthy(version.get("slotResource"))).then(|| (version.get("slotResource").cloned(), version.get("spellcastingClass").cloned()))
        });
        if let Some((resource, class)) = fallback {
            insert_or_remove(&mut card, "fallbackSlotResource", resource);
            insert_or_remove(&mut card, "fallbackSpellcastingClass", class);
        }
        by_id.insert(id, Value::Object(card));
    }
    by_id.into_values().collect()
}

/// Присвоить поле или, для `undefined`, убрать его (JSON его не пишет).
fn insert_or_remove(card: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            card.insert(key.into(), value);
        }
        None => {
            card.shift_remove(key);
        }
    }
}

/// Подготовленная карточка заклинания героя или `None`.
pub fn combat_spell_for(actor: Option<&Value>, spell_id: Option<&Value>, options: Option<&Value>) -> Option<Value> {
    let id = js::s(spell_id);
    spell_index(&id)?;
    let spell = combat_spells_for(actor, options).into_iter().find(|entry| is_str(entry.get("id"), &id))?;
    if js::is_false(spell.get("prepared")) {
        return None;
    }
    Some(spell)
}

/// Каталожная карточка в редакции кампании, без героя.
pub fn canonical_combat_spell_for(spell_id: Option<&Value>, options: Option<&Value>) -> Option<Value> {
    let index = spell_index(&js::s(spell_id))?;
    Some(ruleset_template(index, &ruleset_id_of(options)).clone())
}

const SPELL_ABILITIES: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];
const SPELL_COMPONENT_KEYS: [&str; 3] = ["verbal", "somatic", "material"];

fn declared_components(entry: Option<&Value>, key: &str) -> Vec<&'static str> {
    match prop(entry, key) {
        Some(Value::Array(parts)) => SPELL_COMPONENT_KEYS.iter().copied().filter(|part| jsv::includes_str(parts, part)).collect(),
        _ => Vec::new(),
    }
}

/// Запись заклинания в нормализованном блоке существа.
#[derive(Clone, Debug, PartialEq)]
pub struct MonsterSpellEntry {
    pub id: String,
    /// `None` — лимита нет («неограниченно» или общий пул ячеек).
    pub per_day: Option<f64>,
    pub components_required: Vec<&'static str>,
    pub components_not_required: Vec<&'static str>,
    /// Круг и ресурс общего пула ячеек 2014 (`spell_slots_N`).
    pub shared_slot: Option<(i64, String)>,
}

impl MonsterSpellEntry {
    /// Форма JS.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("id".into(), Value::from(self.id.clone()));
        map.insert("perDay".into(), self.per_day.map_or(Value::Null, num));
        map.insert("componentsRequired".into(), json!(self.components_required));
        map.insert("componentsNotRequired".into(), json!(self.components_not_required));
        if let Some((level, resource)) = &self.shared_slot {
            map.insert("level".into(), Value::from(*level));
            map.insert("slotResource".into(), Value::from(resource.clone()));
        }
        Value::Object(map)
    }
}

/// Нормализованный блок заклинателя из стат-блока.
#[derive(Clone, Debug, PartialEq)]
pub struct MonsterSpellcasting {
    pub ability: String,
    pub save_dc: f64,
    pub attack_bonus: f64,
    pub caster_level: f64,
    pub spellcasting_class: Option<&'static str>,
    pub components_required: Vec<&'static str>,
    pub components_not_required: Vec<&'static str>,
    pub spells: Vec<MonsterSpellEntry>,
    /// Максимумы общих ячеек по кругам 1–9 (по возрастанию круга).
    pub slot_maximums: Option<Vec<(i64, f64)>>,
}

impl MonsterSpellcasting {
    /// Форма JS.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("ability".into(), Value::from(self.ability.clone()));
        map.insert("saveDc".into(), num(self.save_dc));
        map.insert("attackBonus".into(), num(self.attack_bonus));
        map.insert("casterLevel".into(), num(self.caster_level));
        if let Some(class) = self.spellcasting_class {
            map.insert("spellcastingClass".into(), Value::from(class));
        }
        map.insert("componentsRequired".into(), json!(self.components_required));
        map.insert("componentsNotRequired".into(), json!(self.components_not_required));
        map.insert("spells".into(), Value::Array(self.spells.iter().map(MonsterSpellEntry::to_value).collect()));
        if let Some(slots) = &self.slot_maximums {
            map.insert("slotMaximums".into(), Value::Object(slots.iter().map(|(level, maximum)| (level.to_string(), num(*maximum))).collect()));
        }
        Value::Object(map)
    }
}

/// Нормализованный блок стат-блока либо `None`, если существо не заклинатель.
///
/// У современных/авторских блоков встречается схема «неограниченно» и «X в
/// день», а записи MM14 хранят настоящую таблицу общих ячеек 2014 в
/// `spell_slots`: четыре ячейки первого круга — четыре применения на все
/// заклинания круга. СЛ и бонус атаки берутся из блока, а не считаются из
/// характеристик.
pub fn monster_spellcasting_for(actor: Option<&Value>) -> Option<MonsterSpellcasting> {
    let raw = prop(actor, "spellcasting").filter(|raw| raw.is_object())?;
    let raw = Some(raw);
    let mut slot_maximums: IndexMap<i64, f64> = IndexMap::new();
    let mut spell_levels: HashMap<String, i64> = HashMap::new();
    for slot in array(prop(raw, "spell_slots")) {
        let slot = Some(slot);
        let level = js::number(prop(slot, "level")).trunc();
        if !jsv::is_safe_integer(level) || level < 1.0 || level > 9.0 {
            continue;
        }
        let level = level as i64;
        let maximum = jsv::max2(0.0, jsv::number_or(prop(slot, "slots"), 0.0).trunc());
        slot_maximums.insert(level, maximum);
        for spell in array(prop(slot, "spells")) {
            let id = js::s(nullish(prop(Some(spell), "key"), prop(Some(spell), "id")));
            if !id.is_empty() {
                spell_levels.insert(id, level);
            }
        }
    }
    let has_shared_slots = !slot_maximums.is_empty();
    let spells: Vec<MonsterSpellEntry> = array(prop(raw, "spells"))
        .iter()
        .filter_map(|entry| {
            let entry = Some(entry);
            let id = js::s(prop(entry, "id"));
            if id.is_empty() {
                return None;
            }
            let declared_level = js::number(prop(entry, "level")).trunc();
            let level = if jsv::is_safe_integer(declared_level) && declared_level > 0.0 { Some(declared_level as i64) } else { spell_levels.get(&id).copied() };
            let shared_slot = has_shared_slots && level.is_some_and(|level| slot_maximums.contains_key(&level));
            let declared = prop(entry, "uses");
            let per_day = if shared_slot || !js::present(declared) || is_str(declared, MONSTER_SPELL_AT_WILL) {
                None
            } else {
                Some(jsv::max2(0.0, jsv::number_or(declared, 0.0).trunc()))
            };
            Some(MonsterSpellEntry {
                per_day,
                components_required: declared_components(entry, "components_required"),
                components_not_required: declared_components(entry, "components_not_required"),
                shared_slot: if shared_slot { level.map(|level| (level, format!("spell_slots_{level}"))) } else { None },
                id,
            })
        })
        .collect();
    if spells.is_empty() {
        return None;
    }
    let ability = jsv::string(prop(raw, "ability"));
    let class_actor = match prop(raw, "class") {
        Some(class) => json!({ "characterClass": class }),
        None => json!({}),
    };
    let mut slots: Vec<(i64, f64)> = slot_maximums.into_iter().collect();
    slots.sort_by_key(|(level, _)| *level);
    Some(MonsterSpellcasting {
        ability: if SPELL_ABILITIES.contains(&ability.as_str()) { ability } else { "int".into() },
        save_dc: jsv::max2(1.0, jsv::number_or(nullish(prop(raw, "save_dc"), prop(raw, "saveDc")), 10.0).trunc()),
        attack_bonus: jsv::number_or(nullish(prop(raw, "attack_bonus"), prop(raw, "attackBonus")), 0.0).trunc(),
        caster_level: jsv::max2(1.0, jsv::number_or(nullish(prop(raw, "caster_level"), prop(actor, "level")), 1.0).trunc()),
        spellcasting_class: caster_profile(Some(&class_actor)).map(|profile| profile.key),
        components_required: declared_components(raw, "components_required"),
        components_not_required: declared_components(raw, "components_not_required"),
        spells,
        slot_maximums: has_shared_slots.then_some(slots),
    })
}

/// Запись блока по идентификатору заклинания либо `None`.
pub fn monster_spell_entry_for(actor: Option<&Value>, spell_id: Option<&Value>) -> Option<MonsterSpellEntry> {
    let block = monster_spellcasting_for(actor)?;
    let id = js::s(spell_id);
    block.spells.into_iter().find(|entry| entry.id == id)
}

/// Карточка заклинания существа: механика — каталожная, числа — из блока.
///
/// `None` и на «существо не заклинатель», и на «этого заклинания в блоке
/// нет», и на «блок называет заклинание, которого нет в каталоге»; причины
/// разводит [`monster_spell_refusal_for`].
pub fn monster_combat_spell_for(actor: Option<&Value>, spell_id: Option<&Value>, options: Option<&Value>) -> Option<Value> {
    let ruleset_id = ruleset_id_of(options);
    let block = monster_spellcasting_for(actor)?;
    let wanted = js::s(spell_id);
    let entry = block.spells.iter().find(|candidate| candidate.id == wanted)?;
    let index = spell_index(&entry.id)?;
    let spell = &SPELLS[index];
    let mut components = if ruleset_id == DND_2014_RULESET_ID { spell.get("components").cloned() } else { None };
    if ruleset_id == DND_2014_RULESET_ID && js::truthy(components.as_ref()) {
        let required = if entry.components_required.is_empty() { &block.components_required } else { &entry.components_required };
        let waived = if entry.components_not_required.is_empty() { &block.components_not_required } else { &entry.components_not_required };
        if let Some(Value::Object(parts)) = components.as_mut() {
            for part in ["verbal", "somatic"] {
                if required.contains(&part) {
                    parts.insert(part.into(), Value::Bool(true));
                } else if waived.contains(&part) {
                    parts.insert(part.into(), Value::Bool(false));
                }
            }
            if waived.contains(&"material") && !required.contains(&"material") {
                parts.insert("material".into(), Value::Null);
            }
        }
    }
    let mut card = ruleset_template(index, &ruleset_id).as_object().cloned().unwrap_or_default();
    if let Some(components) = components.filter(|components| js::truthy(Some(components))) {
        card.insert("components".into(), components);
    }
    let slot_resource = entry.shared_slot.as_ref().map(|(_, resource)| resource.clone());
    card.insert("slotResource".into(), slot_resource.clone().map_or(Value::Null, Value::from));
    let slot_level = match &entry.shared_slot {
        Some((level, resource)) => {
            let mut slot_profile = spell.as_object().cloned().unwrap_or_default();
            slot_profile.insert("slotResource".into(), Value::from(resource.clone()));
            Some(fixed_spell_slot_level_for(actor, Some(&Value::Object(slot_profile))).unwrap_or_else(|| Value::from(*level)))
        }
        None => spell.get("level").cloned(),
    };
    insert_or_remove(&mut card, "slotLevel", slot_level);
    card.insert("spellcastingAbility".into(), Value::from(block.ability.clone()));
    insert_or_remove(&mut card, "spellcastingClass", block.spellcasting_class.map(Value::from));
    card.insert("prepared".into(), Value::Bool(true));
    let mut monster_spell = Map::new();
    monster_spell.insert("id".into(), Value::from(entry.id.clone()));
    monster_spell.insert("perDay".into(), entry.per_day.map_or(Value::Null, num));
    if let Some((level, _)) = &entry.shared_slot {
        monster_spell.insert("slotLevel".into(), Value::from(*level));
    }
    monster_spell.insert("saveDc".into(), num(block.save_dc));
    monster_spell.insert("attackBonus".into(), num(block.attack_bonus));
    monster_spell.insert("casterLevel".into(), num(block.caster_level));
    card.insert("monsterSpell".into(), Value::Object(monster_spell));
    Some(Value::Object(card))
}

/// Почему существо не может произнести это заклинание: `(текст, код)`;
/// `None` — может. «Нет в блоке» — правило, «нет в каталоге» — дефект
/// стат-блока, о котором нельзя молчать.
pub fn monster_spell_refusal_for(actor: Option<&Value>, spell_id: Option<&Value>) -> Option<(String, &'static str)> {
    let Some(block) = monster_spellcasting_for(actor) else {
        return Some(("Существо не владеет магией".into(), "MONSTER_SPELLCASTING_ABSENT"));
    };
    let id = js::s(spell_id);
    let Some(entry) = block.spells.iter().find(|candidate| candidate.id == id) else {
        return Some(("Этого заклинания нет в стат-блоке существа".into(), "MONSTER_SPELL_NOT_IN_STAT_BLOCK"));
    };
    if spell_index(&entry.id).is_none() {
        return Some((format!("Стат-блок называет заклинание «{}», которого нет в каталоге", entry.id), "MONSTER_SPELL_UNKNOWN"));
    }
    None
}

/// Сколько применений legacy «X в день» уже потрачено, по маркерам состояний.
/// MM14 с общей таблицей ячеек сюда не попадает: его расход живёт в обычном
/// `mechanics.resources[actor].spell_slots_N`.
pub fn monster_spell_uses_spent_in<I, S>(condition_ids: I, spell_id: &str) -> usize
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let prefix = format!("{MONSTER_SPELL_USE_CONDITION_PREFIX}{spell_id}#");
    condition_ids.into_iter().filter(|condition| condition.as_ref().starts_with(&prefix)).count()
}

/// Заклинания блока, которых каталог не знает. Пусто — блок исполним.
pub fn monster_spellcasting_issues(actor: Option<&Value>) -> Vec<String> {
    let Some(block) = monster_spellcasting_for(actor) else {
        return Vec::new();
    };
    block.spells.into_iter().filter(|entry| spell_index(&entry.id).is_none()).map(|entry| entry.id).collect()
}

/// Максимумы ресурсов заклинаний: общие ячейки существа, договор колдуна или
/// ячейки заклинателя класса — `{ spell_slots_N | pact_slots | mystic_arcanum_6: max }`.
pub fn spell_slot_maximums_for(actor: Option<&Value>) -> Value {
    if let Some(slots) = monster_spellcasting_for(actor).and_then(|monster| monster.slot_maximums) {
        return Value::Object(slots.into_iter().map(|(level, maximum)| (format!("spell_slots_{level}"), num(maximum))).collect());
    }
    let Some(profile) = caster_profile(actor) else {
        return json!({});
    };
    let level = bounded_level(actor);
    let mut result = Map::new();
    if profile.progression == Progression::Pact {
        if let Some((slots, _)) = table_at(&WARLOCK_PACT, level).flatten() {
            result.insert("pact_slots".into(), Value::from(slots));
        }
        if level >= 11.0 {
            result.insert("mystic_arcanum_6".into(), Value::from(1));
        }
        return Value::Object(result);
    }
    let slots = if profile.progression == Progression::Full { table_at(&FULL_CASTER_SLOTS, level) } else { table_at(&HALF_CASTER_SLOTS, level) };
    for (index, maximum) in slots.unwrap_or(&[]).iter().enumerate() {
        result.insert(format!("spell_slots_{}", index + 1), Value::from(*maximum));
    }
    Value::Object(result)
}

/// Сводка каталога заклинаний по статусам механики в редакции.
pub fn spell_catalog_info(options: Option<&Value>) -> Value {
    let ruleset_id = ruleset_id_of(options);
    let count = |status: &str| (0..SPELLS.len()).filter(|index| is_str(ruleset_template(*index, &ruleset_id).get("mechanicsSupport"), status)).count();
    let mut info = Map::new();
    info.insert("count".into(), Value::from(SPELLS.len()));
    insert_or_remove(&mut info, "source", PAYLOAD.get("source").cloned());
    insert_or_remove(&mut info, "generatedAt", PAYLOAD.get("generatedAt").cloned());
    info.insert("maximumSpellLevel".into(), Value::from(6));
    info.insert("verifiedMechanics".into(), Value::from(count("verified")));
    info.insert("partialMechanics".into(), Value::from(count("partial")));
    info.insert("heuristicMechanics".into(), Value::from(count("heuristic")));
    info.insert("rulingOnlyMechanics".into(), Value::from(count("ruling-only")));
    Value::Object(info)
}

fn summon_owned(actor: Option<&Value>) -> bool {
    js::truthy(prop(actor, "ownerId")) || js::truthy(prop(actor, "owner_id"))
}

/// Призванное существо отряда.
pub fn is_party_summon(actor: Option<&Value>) -> bool {
    is_str(prop(actor, "kind"), "summon") && is_str(prop(actor, "faction"), "party") && summon_owned(actor)
}

/// Призыв, который не подчиняется призвавшему и враждебен всем («Призыв
/// низших демонов» 2014): стоит среди противников и бьёт ближайшего не-демона.
pub fn is_hostile_summon(actor: Option<&Value>) -> bool {
    is_str(prop(actor, "kind"), "summon") && is_str(prop(actor, "faction"), "hostile") && summon_owned(actor)
}

/// Призыв, которого нельзя ни атаковать, ни ранить (Духовное оружие, Верный пёс).
pub fn is_untargetable_summon(actor: Option<&Value>) -> bool {
    is_party_summon(actor) && js::is_true(prop(actor, "untargetable"))
}

/// Каталог с правками механики (для аудитов и соседей по крейту).
pub(crate) fn catalog_spells() -> &'static [Value] {
    &SPELLS
}

/// Исходный каталог dnd.su без правок.
pub(crate) fn catalog_payload() -> &'static Value {
    &PAYLOAD
}

/// Правки механики как их разобрал бы `JSON.parse`.
pub(crate) fn override_payload() -> &'static Value {
    &OVERRIDE_PAYLOAD
}

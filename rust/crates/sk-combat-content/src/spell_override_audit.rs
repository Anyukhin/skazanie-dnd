//! Перенос `server/spell-override-audit.mjs`: сверка каждой ручной правки
//! механики заклинания (`data/dndsu-spell-mechanics-overrides.json`) с
//! каталогом dnd.su — для `pnpm spells:verify`.
//!
//! Правки существуют потому, что каталог выводит механику из прозы и ошибается;
//! аудит следит, чтобы исправления оставались намеренными. Круг и ячейка не
//! могут расходиться (иначе списывается не тот ресурс), вид и цель обязаны
//! быть исполнимыми, формулы — разбираться, объявленное поле — читаться Rules
//! Engine. Прочие расхождения считаются и показываются.
//!
//! Поля, которые читает движок, собираются из его исходника. Пока движок —
//! `server/rules-engine.mjs`, его текст встроен в сборку так же, как JS читал
//! его при импорте модуля.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{js, re, text};
use sk_dice::parse_dice_expression;

use crate::combat_spells::{catalog_payload, override_payload};
use crate::jsv::{self, array, defined, prop};

/// Сырой текст правок: `JSON.parse` молча оставляет последний из двух
/// одинаковых ключей, и только в тексте ошибка ещё видна.
const OVERRIDE_SOURCE: &str = include_str!("../../../../data/dndsu-spell-mechanics-overrides.json");

/// Исходник Rules Engine, из которого собираются читаемые поля карточки.
const ENGINE_SOURCE: &str = include_str!("../../../../server/rules-engine.mjs");

fn duplicate_override_ids(source: &str) -> Vec<String> {
    let ids: Vec<String> = re!(r#"^\s{4}"([a-z0-9-]+)"\s*:\s*\{"#, "gmu")
        .captures_iter(source)
        .filter_map(Result::ok)
        .filter_map(|captures| captures.get(1).map(|m| m.as_str().to_string()))
        .collect();
    let mut first: HashMap<&str, usize> = HashMap::new();
    for (index, id) in ids.iter().enumerate() {
        first.entry(id.as_str()).or_insert(index);
    }
    let duplicates: IndexSet<String> = ids.iter().enumerate().filter(|(index, id)| first.get(id.as_str()) != Some(index)).map(|(_, id)| id.clone()).collect();
    duplicates.into_iter().collect()
}

/// `BASE_SPELLS`: исходные карточки каталога по id (повтор — последний).
fn base_spells(catalog: &Value) -> HashMap<String, &Value> {
    let mut by_id = HashMap::new();
    for spell in array(catalog.get("spells")) {
        by_id.insert(js::s(spell.get("id")), spell);
    }
    by_id
}

/// Виды, по которым Rules Engine действительно ветвится.
const EXECUTABLE_KINDS: [&str; 11] = ["attack", "save", "area-save", "damage", "area-damage", "debuff", "buff", "utility", "healing", "teleport", "summon"];
const TARGETS: [&str; 5] = ["self", "ally", "enemy", "point", "creature"];
const ABILITIES: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];
const AREA_SHAPES: [&str; 4] = ["sphere", "cone", "cube", "line"];
const CREATURE_TYPES: [&str; 14] = ["humanoid", "undead", "construct", "beast", "fiend", "celestial", "giant", "dragon", "elemental", "fey", "monstrosity", "ooze", "plant", "aberration"];

/// Состояния, следствия которых движок исполняет; «Тьма» и «Свет» — не
/// состояния SRD, но их следствия движок считает наравне с ними.
const ENFORCED_CONDITIONS: [&str; 17] = [
    "blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated", "invisible", "paralyzed", "petrified", "poisoned", "prone", "restrained", "speed-zero", "stunned",
    "unconscious", "magical-darkness", "light",
];

/// Поля карточки, которые Rules Engine действительно читает (`spell.x` и `spell?.x`).
fn fields_read_by_engine(source: &str) -> IndexSet<String> {
    re!(r"\bspell\??\.([A-Za-z_][A-Za-z0-9_]*)", "gu")
        .captures_iter(source)
        .filter_map(Result::ok)
        .filter_map(|captures| captures.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

static FIELDS_READ_BY_ENGINE: LazyLock<IndexSet<String>> = LazyLock::new(|| fields_read_by_engine(ENGINE_SOURCE));

/// Метаданные карточки: их читают каталог и интерфейс, а не движок правил.
const PRESENTATION_FIELDS: [&str; 20] = [
    "mechanicsSupport", "mechanicsAccuracy", "supportNote", "description", "name", "englishName", "mechanics2014", "school", "classes", "ritual", "rangeText", "castingTime", "duration",
    "sourceUrl", "prepared", "damageTypes", "radius", "areaShape", "areaOrigin", "createsAreaEffect",
];

const UPCAST_FIELDS: [&str; 17] = [
    "upcastDicePerLevel", "upcastHealingDicePerLevel", "upcastTargetsPerLevel", "upcastSummonsPerLevel", "summonCountMultiplierBySlotLevel", "upcastBeamsPerLevel", "upcastProjectilesPerLevel",
    "hitPointPoolUpcastDice", "saveDamageUpcastDicePerLevel", "temporaryHpPerSlotLevel", "temporaryHpPerUpcastLevel", "hitPointMaximumBonusPerSlotLevel", "meleeRetaliationDamagePerSlotLevel",
    "delayedDamageUpcastDicePerLevel", "conditionDurationSecondsBySlotLevel", "upcastDiceEveryLevels", "conditionsBySlotLevel",
];

/// Усиление, которое исполняет обработчик, а не поле профиля, — с причиной.
const UPCAST_HANDLED_ELSEWHERE: [(&str, &str); 10] = [
    ("summon-undead", "обобщённый блок духа TCE растёт с ячейкой в обработчике призыва"),
    ("summon-construct", "обобщённый блок духа TCE растёт с ячейкой в обработчике призыва"),
    ("summon-elemental", "обобщённый блок духа TCE растёт с ячейкой в обработчике призыва"),
    ("summon-celestial", "обобщённый блок духа TCE растёт с ячейкой в обработчике призыва"),
    ("summon-draconic-spirit", "обобщённый блок духа TCE растёт с ячейкой в обработчике призыва"),
    ("ensnaring-strike", "урон опутывания растёт с ячейкой в обработчике следующего удара"),
    ("hail-of-thorns", "урон взрыва растёт с ячейкой в обработчике следующего удара"),
    ("absorb-elements", "ячейку выбирает игрок в окне реакции (`slot_level`), кость удара растёт с ней"),
    ("heal", "усиление начинается с 7-го круга, а ячейки выше 6-го в игре нет"),
    ("mass-suggestion", "усиление меняет только срок и начинается с 7-го круга"),
];

fn problem(id: &str, code: &str, message: impl Into<String>) -> Value {
    json!({ "id": id, "code": code, "message": message.into() })
}

fn dice_problem(expression: Option<&Value>, label: &str, id: &str) -> Option<Value> {
    let expression = defined(expression)?;
    let source = jsv::s(Some(expression));
    parse_dice_expression(&source).err().map(|_| problem(id, "INVALID_DICE", format!("{label}: «{source}» не разбирается как формула костей")))
}

fn has_upcast_field(card: &Value, field: &str) -> bool {
    js::present(card.get(field)) || ["createsAreaEffect", "secondaryBurst", "nextWeaponHit", "summon"].iter().any(|nested| js::present(prop(card.get(*nested), field)))
}

/// Ключи `Object.keys(value)` для объекта, массива и строки.
fn object_keys(value: &Value) -> Vec<String> {
    match value {
        Value::Object(map) => js::keys(map).into_iter().cloned().collect(),
        Value::Array(items) => (0..items.len()).map(|index| index.to_string()).collect(),
        Value::String(text) => (0..text.chars().count()).map(|index| index.to_string()).collect(),
        _ => Vec::new(),
    }
}

/// `{ ...original, ...original.mechanics2014 }`: исполнимые поля обеих редакций.
fn merged_override(original: &Value) -> Value {
    if !js::truthy(original.get("mechanics2014")) {
        return original.clone();
    }
    let mut merged = match original {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    jsv::spread_into(&mut merged, original.get("mechanics2014"));
    Value::Object(merged)
}

/// Отчёт аудита правок: `{ ok, checked, upcastGaps, catalog, corrections,
/// correctionsByField, problems, details }`.
pub fn audit_spell_overrides() -> Value {
    audit(OVERRIDE_SOURCE, override_payload(), catalog_payload(), &FIELDS_READ_BY_ENGINE)
}

/// Тот же аудит над явными входами: сырой текст правок, каталог и исходник
/// движка. Нужен проверкам ветвей отказа; ошибка — текст правок не JSON.
pub fn audit_spell_overrides_with(override_source: &str, catalog: &Value, engine_source: &str) -> Result<Value, String> {
    let overrides: Value = serde_json::from_str(override_source).map_err(|error| error.to_string())?;
    Ok(audit(override_source, &jsv::js_ordered_deep(overrides), catalog, &fields_read_by_engine(engine_source)))
}

fn audit(override_source: &str, overrides: &Value, catalog: &Value, fields_read: &IndexSet<String>) -> Value {
    let base_spells = base_spells(catalog);
    let mut problems: Vec<Value> = Vec::new();
    let mut corrections: Vec<Value> = Vec::new();
    let entries: Vec<(&String, &Value)> = match overrides.get("spells") {
        Some(Value::Object(map)) => js::entries(map),
        _ => Vec::new(),
    };
    for id in duplicate_override_ids(override_source) {
        problems.push(problem(&id, "DUPLICATE_OVERRIDE", "заклинание описано дважды: второе определение молча заменяет первое"));
    }
    for (id, original) in &entries {
        let id = id.as_str();
        let card = merged_override(original);
        let Some(base) = base_spells.get(id).copied() else {
            problems.push(problem(id, "UNKNOWN_SPELL", "override описывает заклинание, которого нет в каталоге"));
            continue;
        };
        if !card.is_object() {
            problems.push(problem(id, "INVALID_OVERRIDE", "override обязан быть объектом"));
            continue;
        }
        let field = |key: &str| card.get(key);
        let base_field = |key: &str| base.get(key);

        // --- инварианты, расхождение по которым списывает не тот ресурс ---
        if js::present(field("level")) && !jsv::strict_eq(field("level"), base_field("level")) {
            problems.push(problem(id, "LEVEL_MISMATCH", format!("круг {} против {} в каталоге", jsv::string(field("level")), jsv::string(base_field("level")))));
        }
        if js::present(field("slotResource")) && !jsv::strict_eq(field("slotResource"), base_field("slotResource")) {
            problems.push(problem(id, "SLOT_MISMATCH", format!("ячейка {} против {} в каталоге", jsv::string(field("slotResource")), jsv::string(base_field("slotResource")))));
        }
        if js::present(field("concentration")) && !jsv::strict_eq(field("concentration"), base_field("concentration")) {
            problems.push(problem(id, "CONCENTRATION_MISMATCH", "концентрация не совпадает с каталогом"));
        }

        // --- форма карточки должна быть исполнимой ---
        let kind = jsv::string(jsv::nullish(field("kind"), base_field("kind")));
        if !EXECUTABLE_KINDS.contains(&kind.as_str()) {
            problems.push(problem(id, "UNSUPPORTED_KIND", format!("движок не исполняет вид «{kind}»")));
        }
        let target = jsv::string(jsv::nullish(field("target"), base_field("target")));
        if !TARGETS.contains(&target.as_str()) {
            problems.push(problem(id, "UNKNOWN_TARGET", format!("неизвестная цель «{target}»")));
        }
        if js::present(field("saveAbility")) && !ABILITIES.contains(&jsv::string(field("saveAbility")).as_str()) {
            problems.push(problem(id, "UNKNOWN_SAVE", format!("неизвестная характеристика спасброска «{}»", jsv::string(field("saveAbility")))));
        }
        if js::present(field("areaShape")) && !AREA_SHAPES.contains(&jsv::string(field("areaShape")).as_str()) {
            problems.push(problem(id, "UNKNOWN_AREA_SHAPE", format!("неизвестная форма области «{}»", jsv::string(field("areaShape")))));
        }
        if kind.starts_with("area-") && !(js::number(jsv::nullish(field("radius"), base_field("radius"))) > 0.0) {
            problems.push(problem(id, "AREA_WITHOUT_RADIUS", "площадное заклинание объявлено без радиуса"));
        }
        if kind == "area-save" && !js::present(field("saveAbility")) && !js::present(base_field("saveAbility")) {
            problems.push(problem(id, "AREA_SAVE_WITHOUT_ABILITY", "область со спасброском объявлена без характеристики"));
        }

        // --- формулы обязаны разбираться, иначе карточка падает в бою ---
        for (key, label) in [
            ("damage", "урон"),
            ("healing", "лечение"),
            ("saveDamage", "урон при успешном спасброске"),
            ("bonusDamage", "дополнительный урон"),
            ("delayedDamage", "отложенный урон"),
            ("recurringDamage", "повторный урон"),
            ("hitPointPoolDice", "пул хитов"),
            ("temporaryHpDice", "временные хиты"),
        ] {
            if let Some(found) = dice_problem(field(key), label, id) {
                problems.push(found);
            }
        }

        // --- выбор эффекта обязан быть согласован ---
        for option_field in ["conditionsByOption", "removesConditionsByOption"] {
            let Some(by_option) = defined(field(option_field)) else {
                continue;
            };
            let options: IndexSet<String> = array(field("spellOptions")).iter().map(|option| jsv::string(Some(option))).collect();
            if options.is_empty() {
                problems.push(problem(id, "OPTIONS_MISSING", format!("{option_field} объявлен без spellOptions")));
            }
            for key in object_keys(by_option) {
                if !options.contains(&key) {
                    problems.push(problem(id, "OPTION_UNLISTED", format!("{option_field}: вариант «{key}» отсутствует в spellOptions")));
                }
            }
            for option in &options {
                if !js::truthy(prop(Some(by_option), option)) {
                    problems.push(problem(id, "OPTION_WITHOUT_EFFECT", format!("{option_field}: вариант «{option}» не даёт эффекта")));
                }
            }
        }

        for creature_field in ["requiredCreatureTypes", "immuneCreatureTypes"] {
            for value in array(field(creature_field)) {
                let value = jsv::string(Some(value));
                if !CREATURE_TYPES.contains(&value.as_str()) {
                    problems.push(problem(id, "UNKNOWN_CREATURE_TYPE", format!("{creature_field}: неизвестный тип «{value}»")));
                }
            }
        }

        // --- состояния: помечаем те, что движок не исполняет ---
        let mut declared: Vec<Value> = array(field("conditions")).to_vec();
        if let Some(Value::Object(by_option)) = defined(field("conditionsByOption")) {
            for (_, value) in js::entries(by_option) {
                match value {
                    Value::Array(items) => declared.extend(items.iter().cloned()),
                    other => declared.push(other.clone()),
                }
            }
        }
        declared.extend(array(field("onHitConditions")).iter().cloned());
        let carries_recurring_damage = js::truthy(field("recurringDamage"));
        let unique: IndexSet<String> = declared.iter().map(|condition| jsv::string(Some(condition))).collect();
        for condition in unique {
            let marker = condition.contains(':') || condition.starts_with("spell-effect:");
            if !marker && !ENFORCED_CONDITIONS.contains(&condition.as_str()) && !carries_recurring_damage {
                corrections.push(json!({ "id": id, "field": "conditions", "note": format!("«{condition}» — маркер карточки, механических следствий у него нет") }));
            }
        }

        // --- объявленное поле обязано кем-то читаться ---
        for key in object_keys(&card) {
            if PRESENTATION_FIELDS.contains(&key.as_str()) || fields_read.contains(&key) {
                continue;
            }
            problems.push(problem(id, "FIELD_NEVER_READ", format!("поле «{key}» объявлено в карточке, но Rules Engine его нигде не читает")));
        }

        // --- сколько именно исправлено против автогенерации ---
        for key in ["kind", "target", "saveAbility", "range", "damage", "damageType"] {
            let Some(after) = field(key) else {
                continue;
            };
            let before = defined(base_field(key)).cloned().unwrap_or(Value::Null);
            let after = defined(Some(after)).cloned().unwrap_or(Value::Null);
            if jsv::stringify(&before) != jsv::stringify(&after) {
                corrections.push(json!({ "id": id, "field": key, "from": before, "to": after }));
            }
        }
    }

    // Обещание усиления в тексте карточки без поля, которое его исполняет.
    let mut upcast_gaps: Vec<Value> = Vec::new();
    for (id, original) in &entries {
        let card = merged_override(original);
        let Some(base) = base_spells.get(id.as_str()).copied() else {
            continue;
        };
        if !card.is_object() || ["heuristic", "ruling-only"].contains(&jsv::string(card.get("mechanicsSupport")).as_str()) {
            continue;
        }
        let promise = js::s(base.get("higherLevels"));
        if !text::test(re!(r"\d+к\d+|целей|цель|существ|хит", "iu"), &promise) {
            continue;
        }
        if UPCAST_HANDLED_ELSEWHERE.iter().any(|(handled, _)| handled == id) || UPCAST_FIELDS.iter().any(|upcast| has_upcast_field(&card, upcast)) {
            continue;
        }
        upcast_gaps.push(json!({ "id": id, "higherLevels": text::head(&promise, 160) }));
    }

    let mut by_field = Map::new();
    for correction in &corrections {
        let key = js::s(correction.get("field"));
        let count = by_field.get(&key).and_then(Value::as_i64).unwrap_or(0) + 1;
        by_field.insert(key, Value::from(count));
    }
    json!({
        "ok": problems.is_empty(),
        "checked": entries.len(),
        "upcastGaps": upcast_gaps,
        "catalog": base_spells.len(),
        "corrections": corrections.len(),
        "correctionsByField": Value::Object(jsv::js_ordered(by_field)),
        "problems": problems,
        "details": corrections,
    })
}

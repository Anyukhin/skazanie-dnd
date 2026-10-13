//! Перенос `server/character-creation-class-options.mjs`: данные и проверка
//! классовых выборов для создания героя 1 уровня по PHB 2014 — навыки,
//! инструменты, боевой стиль, мастерство плута, избранный враг и местность
//! следопыта, домены жреца, происхождение чародея, покровитель колдуна.
//!
//! Модуль не зовёт Rules Engine и модель: он лишь превращает выбор игрока в
//! структурированные преимущества класса.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::{js, re, text};

use crate::support::{array, defined, prop, str_array, unique_strings};

const BASIC_RULES_SOURCE: &str = "https://www.dndbeyond.com/sources/dnd/basic-rules-2014/classes";

const DND_SU_CLASS_SOURCES: [(&str, &str); 12] = [
    ("barbarian", "https://www.dnd.su/class/87-barbarian/"),
    ("bard", "https://www.dnd.su/class/88-bard/"),
    ("cleric", "https://www.dnd.su/class/89-cleric/"),
    ("druid", "https://www.dnd.su/class/90-druid/"),
    ("fighter", "https://www.dnd.su/class/91-fighter/"),
    ("monk", "https://www.dnd.su/class/93-monk/"),
    ("paladin", "https://www.dnd.su/class/94-paladin/"),
    ("ranger", "https://www.dnd.su/class/97-ranger/"),
    ("rogue", "https://www.dnd.su/class/99-rogue/"),
    ("sorcerer", "https://www.dnd.su/class/101-sorcerer/"),
    ("warlock", "https://www.dnd.su/class/104-warlock/"),
    ("wizard", "https://www.dnd.su/class/105-wizard/"),
];

/// `CLASS_OPTIONS_PROVENANCE`: редакция и источники классовых данных.
pub static CLASS_OPTIONS_PROVENANCE: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "ruleset_id": "dnd_5e_2014",
        "edition_family": "5e_2014",
        "source_book": "Player's Handbook (2014)",
        "primary_source_url": BASIC_RULES_SOURCE,
        "secondary_source_urls": DND_SU_CLASS_SOURCES.iter().map(|(key, url)| (key.to_string(), json!(url))).collect::<Map<_, _>>(),
    })
});

pub const PHB_2014_CLASS_KEYS: [&str; 12] =
    ["barbarian", "bard", "cleric", "druid", "fighter", "monk", "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard"];

const ALL_SKILLS: [&str; 18] = [
    "acrobatics", "animal_handling", "arcana", "athletics", "deception", "history", "insight", "intimidation", "investigation", "medicine",
    "nature", "perception", "performance", "persuasion", "religion", "sleight_of_hand", "stealth", "survival",
];

const MUSICAL_INSTRUMENTS: [&str; 10] = ["bagpipes", "drum", "dulcimer", "flute", "lute", "lyre", "horn", "pan_flute", "shawm", "viol"];

const ARTISAN_TOOLS: [&str; 17] = [
    "alchemists_supplies", "brewers_supplies", "calligraphers_supplies", "carpenters_tools", "cartographers_tools", "cobblers_tools",
    "cooks_utensils", "glassblowers_tools", "jewelers_tools", "leatherworkers_tools", "masons_tools", "painters_supplies", "potters_tools",
    "smiths_tools", "tinkers_tools", "weavers_tools", "woodcarvers_tools",
];

// Полный список примеров инструментов из таблицы Tools в PHB 2014. Текущий
// каталог предысторий содержит лишь используемые им варианты, поэтому для
// создания класса и авторской предыстории нужен отдельный полный список.
const GAMING_SETS: [&str; 4] = ["dice_set", "dragonchess", "playing_cards", "three_dragon_ante"];
const OTHER_TOOLS: [&str; 8] =
    ["disguise_kit", "forgery_kit", "herbalism_kit", "navigators_tools", "poisoners_kit", "thieves_tools", "vehicles_land", "vehicles_water"];

pub const PHB_2014_GAMING_SETS: [&str; 4] = GAMING_SETS;
pub const PHB_2014_OTHER_TOOLS: [&str; 8] = OTHER_TOOLS;

/// `PHB_2014_TOOL_OPTIONS`: инструменты по видам.
pub static PHB_2014_TOOL_OPTIONS: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "artisan_tools": ARTISAN_TOOLS,
        "musical_instruments": MUSICAL_INSTRUMENTS,
        "gaming_sets": GAMING_SETS,
        "other_tools": OTHER_TOOLS,
    })
});

/// `PHB_2014_TOOL_IDS`: все инструменты PHB 2014 без повторов.
pub static PHB_2014_TOOL_IDS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    let mut ids: Vec<&'static str> = Vec::new();
    for id in ARTISAN_TOOLS.iter().chain(&MUSICAL_INSTRUMENTS).chain(&GAMING_SETS).chain(&OTHER_TOOLS) {
        if !ids.contains(id) {
            ids.push(id);
        }
    }
    ids
});

const TOOL_LABELS: [(&str, &str); 39] = [
    ("alchemists_supplies", "Алхимические принадлежности"),
    ("brewers_supplies", "Принадлежности пивовара"),
    ("calligraphers_supplies", "Инструменты каллиграфа"),
    ("carpenters_tools", "Инструменты плотника"),
    ("cartographers_tools", "Инструменты картографа"),
    ("cobblers_tools", "Инструменты сапожника"),
    ("cooks_utensils", "Кухонная утварь"),
    ("glassblowers_tools", "Инструменты стеклодува"),
    ("jewelers_tools", "Инструменты ювелира"),
    ("leatherworkers_tools", "Инструменты кожевника"),
    ("masons_tools", "Инструменты каменщика"),
    ("painters_supplies", "Принадлежности художника"),
    ("potters_tools", "Инструменты гончара"),
    ("smiths_tools", "Инструменты кузнеца"),
    ("tinkers_tools", "Инструменты ремонтника"),
    ("weavers_tools", "Инструменты ткача"),
    ("woodcarvers_tools", "Инструменты резчика по дереву"),
    ("bagpipes", "Волынка"),
    ("drum", "Барабан"),
    ("dulcimer", "Цимбалы"),
    ("flute", "Флейта"),
    ("lute", "Лютня"),
    ("lyre", "Лира"),
    ("horn", "Рожок"),
    ("pan_flute", "Свирель"),
    ("shawm", "Шалмей"),
    ("viol", "Виола"),
    ("dice_set", "Набор костей"),
    ("dragonchess", "Набор драконьих шахмат"),
    ("playing_cards", "Набор игральных карт"),
    ("three_dragon_ante", "Набор «Ставка трёх драконов»"),
    ("disguise_kit", "Набор для грима"),
    ("forgery_kit", "Набор для подделок"),
    ("herbalism_kit", "Набор травника"),
    ("navigators_tools", "Инструменты навигатора"),
    ("poisoners_kit", "Инструменты отравителя"),
    ("thieves_tools", "Воровские инструменты"),
    ("vehicles_land", "Наземный транспорт"),
    ("vehicles_water", "Водный транспорт"),
];

const TOOL_WEIGHTS: [(&str, f64); 39] = [
    ("alchemists_supplies", 8.0),
    ("brewers_supplies", 9.0),
    ("calligraphers_supplies", 5.0),
    ("carpenters_tools", 6.0),
    ("cartographers_tools", 6.0),
    ("cobblers_tools", 5.0),
    ("cooks_utensils", 8.0),
    ("glassblowers_tools", 5.0),
    ("jewelers_tools", 2.0),
    ("leatherworkers_tools", 5.0),
    ("masons_tools", 8.0),
    ("painters_supplies", 5.0),
    ("potters_tools", 3.0),
    ("smiths_tools", 8.0),
    ("tinkers_tools", 10.0),
    ("weavers_tools", 5.0),
    ("woodcarvers_tools", 5.0),
    ("bagpipes", 6.0),
    ("drum", 3.0),
    ("dulcimer", 10.0),
    ("flute", 1.0),
    ("lute", 2.0),
    ("lyre", 2.0),
    ("horn", 2.0),
    ("pan_flute", 2.0),
    ("shawm", 1.0),
    ("viol", 1.0),
    ("dice_set", 0.0),
    ("dragonchess", 0.5),
    ("playing_cards", 0.0),
    ("three_dragon_ante", 0.0),
    ("disguise_kit", 3.0),
    ("forgery_kit", 5.0),
    ("herbalism_kit", 3.0),
    ("navigators_tools", 2.0),
    ("poisoners_kit", 2.0),
    ("thieves_tools", 1.0),
    ("vehicles_land", 0.0),
    ("vehicles_water", 0.0),
];

fn tool_label(id: &str) -> Option<&'static str> {
    TOOL_LABELS.iter().find(|(key, _)| *key == id).map(|(_, label)| *label)
}

fn tool_weight(id: &str) -> Option<f64> {
    TOOL_WEIGHTS.iter().find(|(key, _)| *key == id).map(|(_, weight)| *weight)
}

/// `PHB_2014_TOOL_CATALOG`: инструменты PHB 2014 с видом, подписью и весом.
pub static PHB_2014_TOOL_CATALOG: LazyLock<Value> = LazyLock::new(|| {
    let entry = |kind: &'static str| {
        move |id: &&str| {
            let mut entry = Map::new();
            entry.insert("id".into(), json!(id));
            entry.insert("kind".into(), json!(kind));
            if let Some(label) = tool_label(id) {
                entry.insert("label".into(), json!(label));
            }
            if let Some(weight) = tool_weight(id) {
                entry.insert("weight".into(), js::num(weight));
            }
            Value::Object(entry)
        }
    };
    Value::Array(
        ARTISAN_TOOLS
            .iter()
            .map(entry("artisan_tool"))
            .chain(MUSICAL_INSTRUMENTS.iter().map(entry("musical_instrument")))
            .chain(GAMING_SETS.iter().map(entry("gaming_set")))
            .chain(OTHER_TOOLS.iter().map(entry("other_tool")))
            .collect(),
    )
});

const DRUID_CANTRIPS: [&str; 8] = ["druidcraft", "guidance", "mending", "poison_spray", "produce_flame", "resistance", "shillelagh", "thorn_whip"];

pub const PHB_2014_MUSICAL_INSTRUMENTS: [&str; 10] = MUSICAL_INSTRUMENTS;
pub const PHB_2014_ARTISAN_TOOLS: [&str; 17] = ARTISAN_TOOLS;
pub const PHB_2014_DRUID_CANTRIPS: [&str; 8] = DRUID_CANTRIPS;
pub const PHB_2014_SKILLS: [&str; 18] = ALL_SKILLS;

/// Драконьи предки: id, подпись, тип урона.
const DRACONIC_ANCESTRIES: [(&str, &str, &str); 10] = [
    ("black", "Чёрный", "acid"),
    ("blue", "Синий", "lightning"),
    ("brass", "Латунный", "fire"),
    ("bronze", "Бронзовый", "lightning"),
    ("copper", "Медный", "acid"),
    ("gold", "Золотой", "fire"),
    ("green", "Зелёный", "poison"),
    ("red", "Красный", "fire"),
    ("silver", "Серебряный", "cold"),
    ("white", "Белый", "cold"),
];

/// `PHB_2014_DRACONIC_ANCESTRIES`: `{ black: { label, damage_type }, … }`.
pub static PHB_2014_DRACONIC_ANCESTRIES: LazyLock<Value> = LazyLock::new(|| {
    Value::Object(
        DRACONIC_ANCESTRIES
            .iter()
            .map(|(id, label, damage_type)| (id.to_string(), json!({ "label": label, "damage_type": damage_type })))
            .collect(),
    )
});

const FAVORED_ENEMY_TYPES: [&str; 14] = [
    "aberrations", "beasts", "celestials", "constructs", "dragons", "elementals", "fey", "fiends", "giants", "humanoids", "monstrosities",
    "oozes", "plants", "undead",
];

// Эти группы имеют обычный язык в базовом справочнике. Для остальных типов
// правила оставляют возможность, что конкретные враги вообще не говорят.
const FAVORED_ENEMY_LANGUAGE_REQUIRED_TYPES: [&str; 8] =
    ["aberrations", "celestials", "dragons", "elementals", "fey", "fiends", "giants", "humanoids"];

const NATURAL_EXPLORER_TERRAINS: [&str; 8] = ["arctic", "coast", "desert", "forest", "grassland", "mountain", "swamp", "underdark"];

pub const PHB_2014_FAVORED_ENEMY_TYPES: [&str; 14] = FAVORED_ENEMY_TYPES;
pub const PHB_2014_FAVORED_ENEMY_LANGUAGE_REQUIRED_TYPES: [&str; 8] = FAVORED_ENEMY_LANGUAGE_REQUIRED_TYPES;
pub const PHB_2014_NATURAL_EXPLORER_TERRAINS: [&str; 8] = NATURAL_EXPLORER_TERRAINS;

const FIGHTING_STYLES: [&str; 6] = ["archery", "defense", "dueling", "great_weapon_fighting", "protection", "two_weapon_fighting"];

fn class_skill(count: i64, options: &[&str]) -> Value {
    json!({ "count": count, "choice_count": count, "options": options })
}

fn feature(id: &str, name: &str, summary: &str) -> Value {
    json!({ "id": id, "name": name, "level": 1, "summary": summary })
}

fn spellcasting(ability: &str, details: Value) -> Value {
    let mut result = Map::new();
    result.insert("ability".into(), json!(ability));
    if let Value::Object(details) = details {
        result.extend(details);
    }
    Value::Object(result)
}

fn domain_spells(spell_ids: &[&str]) -> Value {
    json!({ "1": spell_ids, "always_prepared": true, "counts_against_prepared_limit": false })
}

fn domain_spells_by_level(spells: &[(&str, &[&str])]) -> Value {
    let mut result: Map<String, Value> = spells.iter().map(|(level, ids)| (level.to_string(), json!(ids))).collect();
    result.insert("always_prepared".into(), json!(true));
    result.insert("counts_against_prepared_limit".into(), json!(false));
    Value::Object(crate::support::js_ordered(result))
}

fn barbarian() -> Value {
    json!({
        "id": "barbarian", "label": "Варвар", "english_name": "Barbarian", "hit_die": 12,
        "primary_abilities": ["str"], "saving_throw_proficiencies": ["str", "con"],
        "armor_proficiencies": ["light", "medium", "shields"], "weapon_proficiencies": ["simple", "martial"],
        "tool_proficiencies": [],
        "skill_choice": class_skill(2, &["athletics", "perception", "survival", "intimidation", "nature", "animal_handling"]),
        "subclass_options": [],
        "features": [
            feature("rage", "Ярость", "Два использования за продолжительный отдых; бонусное действие, сопротивление дробящему, колющему и рубящему урону."),
            feature("unarmored-defense", "Защита без доспехов", "КД равен 10 + модификатор Ловкости + модификатор Телосложения без доспехов; щит использовать можно."),
        ],
        "spellcasting": null,
    })
}

fn bard() -> Value {
    json!({
        "id": "bard", "label": "Бард", "english_name": "Bard", "hit_die": 8,
        "primary_abilities": ["cha"], "saving_throw_proficiencies": ["dex", "cha"],
        "armor_proficiencies": ["light"], "weapon_proficiencies": ["simple", "hand_crossbow", "longsword", "rapier", "shortsword"],
        "tool_proficiencies": [],
        "tool_choice": { "id": "musical_instruments", "kind": "musical_instrument", "count": 3, "options": MUSICAL_INSTRUMENTS },
        "skill_choice": class_skill(3, &ALL_SKILLS),
        "subclass_options": [],
        "features": [
            feature("spellcasting", "Использование заклинаний", "Харизма — ключевая характеристика заклинаний барда."),
            feature("bardic-inspiration", "Бардовское вдохновение", "Бонусным действием одно существо в пределах 60 футов получает кость бардовского вдохновения 1к6 на 10 минут; её можно добавить к одной проверке, атаке или спасброску."),
        ],
        "spellcasting": spellcasting("cha", json!({ "cantrips_known": 2, "spells_known": 4, "first_level_spell_slots": 2 })),
    })
}

fn cleric() -> Value {
    json!({
        "id": "cleric", "label": "Жрец", "english_name": "Cleric", "hit_die": 8,
        "primary_abilities": ["wis"], "saving_throw_proficiencies": ["wis", "cha"],
        "armor_proficiencies": ["light", "medium", "shields"], "weapon_proficiencies": ["simple"],
        "tool_proficiencies": [],
        "skill_choice": class_skill(2, &["history", "insight", "medicine", "persuasion", "religion"]),
        "subclass_level": 1,
        "subclass_label": "Божественный домен",
        "subclass_options": cleric_domains(),
        "features": [
            feature("spellcasting", "Использование заклинаний", "Мудрость — ключевая характеристика заклинаний жреца."),
            feature("divine-domain", "Божественный домен", "Выберите один домен, связанный с божеством; выбор даёт доменные заклинания и особенности на 1 уровне."),
        ],
        "spellcasting": spellcasting("wis", json!({ "cantrips_known": 3, "prepared_formula": "wisdom_modifier + cleric_level (minimum 1)", "first_level_spell_slots": 2 })),
    })
}

fn druid() -> Value {
    json!({
        "id": "druid", "label": "Друид", "english_name": "Druid", "hit_die": 8,
        "primary_abilities": ["wis"], "saving_throw_proficiencies": ["int", "wis"],
        "armor_proficiencies": ["light", "medium", "shields"], "armor_restrictions": ["nonmetal"],
        "weapon_proficiencies": ["club", "dagger", "dart", "javelin", "mace", "quarterstaff", "scimitar", "sickle", "sling", "spear"],
        "tool_proficiencies": ["herbalism_kit"],
        "skill_choice": class_skill(2, &["arcana", "animal_handling", "insight", "medicine", "nature", "perception", "religion", "survival"]),
        "subclass_options": [],
        "features": [
            feature("druidic", "Друидический", "Вы знаете тайный язык друидов и можете оставлять скрытые послания."),
            feature("spellcasting", "Использование заклинаний", "Мудрость — ключевая характеристика заклинаний друида."),
        ],
        "spellcasting": spellcasting("wis", json!({ "cantrips_known": 2, "prepared_formula": "wisdom_modifier + druid_level (minimum 1)", "first_level_spell_slots": 2 })),
    })
}

fn fighter() -> Value {
    json!({
        "id": "fighter", "label": "Воин", "english_name": "Fighter", "hit_die": 10,
        "primary_abilities": ["str", "dex"], "saving_throw_proficiencies": ["str", "con"],
        "armor_proficiencies": ["light", "medium", "heavy", "shields"], "weapon_proficiencies": ["simple", "martial"],
        "tool_proficiencies": [],
        "skill_choice": class_skill(2, &["acrobatics", "animal_handling", "athletics", "history", "insight", "intimidation", "perception", "survival"]),
        "subclass_options": [],
        "tool_choice": { "id": "fighting_style", "kind": "fighting_style", "count": 1, "options": FIGHTING_STYLES },
        "features": [
            feature("fighting-style", "Боевой стиль", "Выберите один боевой стиль из шести вариантов PHB 2014."),
            feature("second-wind", "Второе дыхание", "Бонусным действием восстановите 1к10 + уровень хитов; восстановление после короткого или продолжительного отдыха."),
        ],
        "spellcasting": null,
    })
}

fn monk() -> Value {
    let options: Vec<&str> = ARTISAN_TOOLS.iter().chain(&MUSICAL_INSTRUMENTS).copied().collect();
    json!({
        "id": "monk", "label": "Монах", "english_name": "Monk", "hit_die": 8,
        "primary_abilities": ["dex", "wis"], "saving_throw_proficiencies": ["str", "dex"],
        "armor_proficiencies": [], "weapon_proficiencies": ["simple", "shortsword"], "tool_proficiencies": [],
        "tool_choice": {
            "id": "artisan_tool_or_musical_instrument", "kind": "artisan_tool_or_musical_instrument", "count": 1,
            "options": options,
            "option_kinds": { "artisan_tools": ARTISAN_TOOLS, "musical_instruments": MUSICAL_INSTRUMENTS },
        },
        "skill_choice": class_skill(2, &["acrobatics", "athletics", "history", "insight", "religion", "stealth"]),
        "subclass_options": [],
        "features": [
            feature("unarmored-defense", "Защита без доспехов", "КД равен 10 + модификатор Ловкости + модификатор Мудрости без доспехов и щита."),
            feature("martial-arts", "Боевые искусства", "Безоружные удары и оружие монаха используют кость 1к4 и позволяют безоружный удар бонусным действием."),
        ],
        "spellcasting": null,
    })
}

fn paladin() -> Value {
    json!({
        "id": "paladin", "label": "Паладин", "english_name": "Paladin", "hit_die": 10,
        "primary_abilities": ["str", "cha"], "saving_throw_proficiencies": ["wis", "cha"],
        "armor_proficiencies": ["light", "medium", "heavy", "shields"], "weapon_proficiencies": ["simple", "martial"],
        "tool_proficiencies": [],
        "skill_choice": class_skill(2, &["athletics", "insight", "intimidation", "medicine", "persuasion", "religion"]),
        "subclass_options": [],
        "features": [
            feature("divine-sense", "Божественное чувство", "Количество использований равно 1 + модификатор Харизмы, минимум одно; восстановление после продолжительного отдыха."),
            feature("lay-on-hands", "Наложение рук", "Запас целительных сил равен пяти хитов на уровень паладина; восстанавливается после продолжительного отдыха."),
        ],
        "spellcasting": null,
    })
}

fn ranger() -> Value {
    json!({
        "id": "ranger", "label": "Следопыт", "english_name": "Ranger", "hit_die": 10,
        "primary_abilities": ["dex", "wis"], "saving_throw_proficiencies": ["str", "dex"],
        "armor_proficiencies": ["light", "medium", "shields"], "weapon_proficiencies": ["simple", "martial"],
        "tool_proficiencies": [],
        "skill_choice": class_skill(3, &["animal_handling", "athletics", "insight", "investigation", "nature", "perception", "stealth", "survival"]),
        "subclass_options": [],
        "features": [
            feature("favored-enemy", "Избранный враг", "Выберите тип врага либо две расы гуманоидов; получите преимущество на проверки отслеживания и изучите язык, если избранные враги вообще говорят на языке."),
            feature("natural-explorer", "Исследователь природы", "Выберите один тип предпочитаемой местности; в нём действуют преимущества исследователя."),
        ],
        "spellcasting": null,
    })
}

fn rogue() -> Value {
    let expertise_options: Vec<&str> = ALL_SKILLS.iter().copied().chain(["thieves_tools"]).collect();
    json!({
        "id": "rogue", "label": "Плут", "english_name": "Rogue", "hit_die": 8,
        "primary_abilities": ["dex"], "saving_throw_proficiencies": ["dex", "int"],
        "armor_proficiencies": ["light"], "weapon_proficiencies": ["simple", "hand_crossbow", "longsword", "rapier", "shortsword"],
        "tool_proficiencies": ["thieves_tools"],
        "skill_choice": class_skill(4, &["acrobatics", "athletics", "deception", "insight", "intimidation", "investigation", "perception", "performance", "persuasion", "sleight_of_hand", "stealth"]),
        "subclass_options": [],
        "choices": [{ "id": "expertise", "count": 2, "kind": "expertise", "options": expertise_options, "requires_proficiency": true }],
        "features": [
            feature("expertise", "Мастерство", "Выберите два владения навыками либо одно владение навыком и воровскими инструментами; бонус мастерства удваивается."),
            feature("sneak-attack", "Скрытая атака", "Один раз за ход добавьте 1к6 урона подходящей атаке при наличии преимущества или союзника рядом с целью."),
            feature("thieves-cant", "Воровской жаргон", "Тайный язык и набор знаков, известный преступному миру."),
        ],
        "spellcasting": null,
    })
}

fn sorcerer() -> Value {
    json!({
        "id": "sorcerer", "label": "Чародей", "english_name": "Sorcerer", "hit_die": 6,
        "primary_abilities": ["cha"], "saving_throw_proficiencies": ["con", "cha"],
        "armor_proficiencies": [], "weapon_proficiencies": ["dagger", "dart", "sling", "quarterstaff", "light_crossbow"],
        "tool_proficiencies": [],
        "skill_choice": class_skill(2, &["arcana", "deception", "insight", "intimidation", "persuasion", "religion"]),
        "subclass_level": 1, "subclass_label": "Происхождение чародея", "subclass_options": sorcerer_origins(),
        "features": [
            feature("spellcasting", "Использование заклинаний", "Харизма — ключевая характеристика заклинаний чародея."),
            feature("sorcerous-origin", "Происхождение чародея", "Выберите источник врождённой магии; он даёт особенности на 1 уровне."),
        ],
        "spellcasting": spellcasting("cha", json!({ "cantrips_known": 4, "spells_known": 2, "first_level_spell_slots": 2 })),
    })
}

fn warlock() -> Value {
    json!({
        "id": "warlock", "label": "Колдун", "english_name": "Warlock", "hit_die": 8,
        "primary_abilities": ["cha"], "saving_throw_proficiencies": ["wis", "cha"],
        "armor_proficiencies": ["light"], "weapon_proficiencies": ["simple"], "tool_proficiencies": [],
        "skill_choice": class_skill(2, &["arcana", "deception", "history", "intimidation", "investigation", "nature", "religion"]),
        "subclass_level": 1, "subclass_label": "Потусторонний покровитель", "subclass_options": warlock_patrons(),
        "features": [
            feature("otherworldly-patron", "Потусторонний покровитель", "Выберите покровителя; он даёт особенность на 1 уровне."),
            feature("pact-magic", "Магия договора", "Харизма — ключевая характеристика; одна ячейка заклинаний 1 круга восстанавливается после короткого или продолжительного отдыха."),
        ],
        "spellcasting": spellcasting("cha", json!({ "cantrips_known": 2, "spells_known": 2, "pact_magic_slots": 1, "pact_magic_slot_level": 1 })),
    })
}

fn wizard() -> Value {
    json!({
        "id": "wizard", "label": "Волшебник", "english_name": "Wizard", "hit_die": 6,
        "primary_abilities": ["int"], "saving_throw_proficiencies": ["int", "wis"],
        "armor_proficiencies": [], "weapon_proficiencies": ["dagger", "dart", "sling", "quarterstaff", "light_crossbow"],
        "tool_proficiencies": [],
        "skill_choice": class_skill(2, &["arcana", "history", "insight", "investigation", "medicine", "religion"]),
        "subclass_options": [],
        "features": [
            feature("spellcasting", "Использование заклинаний", "Интеллект — ключевая характеристика заклинаний волшебника; книга содержит шесть заклинаний 1 круга."),
            feature("arcane-recovery", "Магическое восстановление", "После короткого отдыха восстановите ячейки суммарным уровнем до половины уровня волшебника."),
        ],
        "spellcasting": spellcasting("int", json!({ "cantrips_known": 3, "spellbook_first_level_spells": 6, "prepared_formula": "intelligence_modifier + wizard_level (minimum 1)", "first_level_spell_slots": 2 })),
    })
}

fn cleric_domains() -> Value {
    let heavy = "Вы получаете владение тяжёлыми доспехами.";
    let martial_and_heavy = "Владение боевым оружием и тяжёлыми доспехами.";
    json!([
        {
            "id": "knowledge", "label": "Домен знаний", "aliases": ["cleric-domen-znaniy", "домен знаний"],
            "features": [feature("blessings-of-knowledge", "Благословение знаний", "Два выбранных языка, два навыка из списка домена и удвоенный бонус мастерства для проверок выбранных навыков.")],
            "domain_spells": domain_spells(&["identify", "command"]),
            "choices": {
                "knowledge_skills": { "count": 2, "options": ["history", "arcana", "nature", "religion"] },
                "knowledge_languages": { "count": 2, "kind": "language" },
            },
        },
        {
            "id": "life", "label": "Домен жизни", "aliases": ["cleric-domen-zhizni", "домен жизни"],
            "features": [feature("bonus-proficiency-heavy-armor", "Дополнительное владение", heavy), feature("disciple-of-life", "Ученик жизни", "Заклинания 1 круга и выше, восстанавливающие хиты, восстанавливают дополнительно 2 + круг заклинания.")],
            "additional_armor_proficiencies": ["heavy"], "domain_spells": domain_spells(&["bless", "cure_wounds"]),
        },
        {
            "id": "light", "label": "Домен света", "aliases": ["cleric-domen-sveta", "домен света"],
            "features": [feature("bonus-cantrip-light", "Дополнительный заговор", "Вы изучаете заговор Свет."), feature("warding-flare", "Ослепляющая вспышка", "Реакцией навяжите атакующему помеху; число использований равно модификатору Мудрости, минимум одно.")],
            "domain_spells": domain_spells(&["burning_hands", "faerie_fire"]),
        },
        {
            "id": "nature", "label": "Домен природы", "aliases": ["cleric-domen-prirody", "домен природы"],
            "features": [feature("acolyte-of-nature", "Послушник природы", "Один заговор из списка друида и владение одним навыком: Уход за животными, Природа или Выживание."), feature("bonus-proficiency-heavy-armor", "Дополнительное владение", heavy)],
            "additional_armor_proficiencies": ["heavy"], "domain_spells": domain_spells(&["animal_friendship", "speak_with_animals"]),
            "choices": {
                "nature_cantrip": { "kind": "druid_cantrip", "count": 1, "options": DRUID_CANTRIPS },
                "nature_skill": { "kind": "skill", "count": 1, "options": ["animal_handling", "nature", "survival"] },
            },
        },
        {
            "id": "tempest", "label": "Домен бури", "aliases": ["cleric-domen-buri", "домен бури"],
            "features": [feature("bonus-proficiencies", "Дополнительные владения", martial_and_heavy), feature("wrath-of-the-storm", "Гнев бури", "Реакцией нанесите урон молнией или громом существу, которое вас атакует.")],
            "additional_armor_proficiencies": ["heavy"], "additional_weapon_proficiencies": ["martial"],
            "domain_spells": domain_spells_by_level(&[
                ("1", &["fog_cloud", "thunderwave"]),
                ("3", &["gust_of_wind", "shatter"]),
                ("5", &["call_lightning", "sleet_storm"]),
                ("7", &["control_water", "ice_storm"]),
                ("9", &["destructive_wave", "insect_plague"]),
            ]),
        },
        {
            "id": "trickery", "label": "Домен обмана", "aliases": ["cleric-domen-obmana", "домен обмана"],
            "features": [feature("blessing-of-the-trickster", "Благословение обманщика", "Действием коснитесь существа и дайте ему преимущество на проверки Ловкости (Скрытность) на 1 час.")],
            "domain_spells": domain_spells(&["charm_person", "disguise_self"]),
        },
        {
            "id": "war", "label": "Домен войны", "aliases": ["cleric-domen-voyny", "домен войны"],
            "features": [feature("bonus-proficiencies", "Дополнительные владения", martial_and_heavy), feature("war-priest", "Военный жрец", "После действия Атака совершите одну атаку бонусным действием; число использований равно модификатору Мудрости, минимум одно.")],
            "additional_armor_proficiencies": ["heavy"], "additional_weapon_proficiencies": ["martial"], "domain_spells": domain_spells(&["divine_favor", "shield_of_faith"]),
        },
    ])
}

fn sorcerer_origins() -> Value {
    let ancestries: Vec<&str> = DRACONIC_ANCESTRIES.iter().map(|(id, _, _)| *id).collect();
    json!([
        {
            "id": "draconic-bloodline", "label": "Наследие драконьей крови", "aliases": ["draconic", "draconic-origin", "наследие драконьей крови"],
            "features": [feature("dragon-ancestor", "Драконий предок", "Выберите цвет дракона; получите соответствующий тип урона и владение Драконьим языком."), feature("draconic-resilience", "Драконья стойкость", "Максимум хитов увеличивается на 1 за каждый уровень чародея; КД без доспехов равен 13 + модификатор Ловкости.")],
            "choices": { "draconic_ancestry": { "kind": "dragon_ancestry", "count": 1, "options": ancestries } },
        },
        {
            "id": "wild-magic", "label": "Дикая магия", "aliases": ["wild-magic-origin", "дикая магия"],
            "features": [feature("wild-magic-surge", "Всплеск дикой магии", "После заклинания 1 круга или выше Мастер может попросить бросок на всплеск дикой магии."), feature("tides-of-chaos", "Приливы хаоса", "Получите преимущество на одну проверку, бросок атаки или спасбросок; восстановление по решению Мастера после всплеска.")],
        },
    ])
}

fn warlock_patrons() -> Value {
    json!([
        {
            "id": "archfey", "label": "Архифея", "aliases": ["warlock-archfey", "архифея"],
            "features": [feature("fey-presence", "Присутствие фей", "Действием очаруйте или испугайте существ в кубе 10 футов; восстановление после короткого или продолжительного отдыха.")],
            "expanded_spell_list": { "1": ["faerie_fire", "sleep"] },
        },
        {
            "id": "fiend", "label": "Исчадие", "aliases": ["warlock-fiend", "исчадие"],
            "features": [feature("dark-ones-blessing", "Благословение тёмного", "Когда враждебное существо падает до 0 хитов, получите временные хиты, равные модификатору Харизмы + уровень колдуна, минимум 1.")],
            "expanded_spell_list": { "1": ["burning_hands", "command"] },
        },
        {
            "id": "great-old-one", "label": "Великий Древний", "aliases": ["great-old-one", "warlock-great-old-one", "великий древний"],
            "features": [feature("awakened-mind", "Пробуждённый разум", "Телепатически общайтесь с выбранным существом в пределах 30 футов.")],
            "expanded_spell_list": { "1": ["dissonant_whispers", "tashas_hideous_laughter"] },
        },
    ])
}

/// `PHB_2014_CLASS_OPTIONS`: двенадцать классов PHB 2014, ключ — id класса.
pub static PHB_2014_CLASS_OPTIONS: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "barbarian": barbarian(),
        "bard": bard(),
        "cleric": cleric(),
        "druid": druid(),
        "fighter": fighter(),
        "monk": monk(),
        "paladin": paladin(),
        "ranger": ranger(),
        "rogue": rogue(),
        "sorcerer": sorcerer(),
        "warlock": warlock(),
        "wizard": wizard(),
    })
});

fn definition(class_key: &str) -> &'static Value {
    &PHB_2014_CLASS_OPTIONS[class_key]
}

/// `normalizedToken(value)`: нижний регистр, «ё» → «е», всё кроме букв и цифр
/// — `_`, без `_` по краям.
fn normalized_token(value: Option<&Value>) -> String {
    let lowered = text::lower(text::trim(&js::s(value))).replace('ё', "е");
    let replaced = text::replace_all(re!(r"[^a-zа-я0-9]+", "giu"), &lowered, "_");
    text::replace_all(re!(r"^_+|_+$", "gu"), &replaced, "")
}

fn token_of(text: &str) -> String {
    normalized_token(Some(&Value::String(text.to_string())))
}

/// `canonicalFrom(value, values, aliases)`: каноническое значение по токену
/// ввода; псевдонимы перекрывают значения, поздние — ранние.
fn canonical_from(value: Option<&Value>, values: &[&str], aliases: &[(&str, Vec<String>)]) -> Option<String> {
    let token = normalized_token(value);
    let mut map: HashMap<String, String> = values.iter().map(|entry| (token_of(entry), entry.to_string())).collect();
    for (canonical, names) in aliases {
        for name in names {
            map.insert(token_of(name), canonical.to_string());
        }
    }
    map.remove(&token)
}

/// Псевдонимы `[id, [id с дефисами, id с пробелами]]`.
fn spelled_aliases<'a>(ids: &[&'a str]) -> Vec<(&'a str, Vec<String>)> {
    ids.iter().map(|id| (*id, vec![id.replace('_', "-"), id.replace('_', " ")])).collect()
}

fn canonical_class_key(value: Option<&Value>) -> Option<&'static str> {
    let key = text::lower(text::trim(&js::s(value)));
    PHB_2014_CLASS_KEYS.iter().copied().find(|candidate| *candidate == key)
}

fn canonical_skill(value: Option<&Value>) -> Option<String> {
    canonical_from(value, &ALL_SKILLS, &spelled_aliases(&ALL_SKILLS))
}

fn canonical_instrument(value: Option<&Value>) -> Option<String> {
    canonical_from(value, &MUSICAL_INSTRUMENTS, &spelled_aliases(&MUSICAL_INSTRUMENTS))
}

fn canonical_artisan_tool(value: Option<&Value>) -> Option<String> {
    canonical_from(value, &ARTISAN_TOOLS, &spelled_aliases(&ARTISAN_TOOLS))
}

/// Выбор из списка с канонизацией (`exactSelection`). Отбракованное значение
/// остаётся `None` — как `null` в JS.
type Selection = Vec<Option<String>>;

fn selection_value(selection: &[Option<String>]) -> Value {
    Value::Array(selection.iter().map(|entry| entry.as_ref().map_or(Value::Null, |text| json!(text))).collect())
}

fn exact_selection(
    input: Option<&Value>,
    count: usize,
    options: &[String],
    label: &str,
    canonicalizer: &dyn Fn(Option<&Value>) -> Option<String>,
    errors: &mut Vec<String>,
) -> Selection {
    let items = match input {
        Some(Value::Array(items)) if items.len() == count => items,
        _ => {
            errors.push(format!("{label}: нужно выбрать ровно {count}"));
            return Vec::new();
        }
    };
    let selected: Selection = items.iter().map(|item| canonicalizer(Some(item))).collect();
    if selected.iter().any(|value| value.as_ref().is_none_or(|value| value.is_empty() || !options.contains(value))) {
        errors.push(format!("{label}: выбран недопустимый вариант"));
    }
    let mut unique: Vec<&Option<String>> = Vec::new();
    for value in &selected {
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    if unique.len() != selected.len() {
        errors.push(format!("{label}: варианты нельзя повторять"));
    }
    selected
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

/// `firstChoice(source, keys)`: первое поле, которое не `undefined`.
fn first_choice<'a>(source: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| source.get(*key))
}

/// `stringList(source, keys)`: массив как есть, одиночное значение — массив из
/// него, `null` — пусто.
fn string_list(source: &Map<String, Value>, keys: &[&str]) -> Value {
    match first_choice(source, keys) {
        Some(Value::Array(items)) => Value::Array(items.clone()),
        None | Some(Value::Null) => Value::Array(Vec::new()),
        Some(other) => Value::Array(vec![other.clone()]),
    }
}

/// `normalizeLanguage(value)`: строка без пробелов по краям или `None`.
fn normalize_language(value: Option<&Value>) -> Option<String> {
    let result = text::trim(&js::s(value)).to_string();
    (!result.is_empty()).then_some(result)
}

fn selected_subclass(definition: &'static Value, raw_value: Option<&Value>, errors: &mut Vec<String>) -> Option<&'static Value> {
    let label = js::s(definition.get("subclass_label"));
    let has_text = |value: Option<&Value>| js::present(value) && !text::trim(&js::s(value)).is_empty();
    if definition.get("subclass_level") != Some(&json!(1)) {
        if has_text(raw_value) {
            errors.push("У этого класса нет выбора подкласса на 1 уровне по PHB 2014".into());
        }
        return None;
    }
    if !has_text(raw_value) {
        errors.push(format!("{label}: нужно выбрать вариант"));
        return None;
    }
    let token = normalized_token(raw_value);
    let option = array(definition.get("subclass_options")).iter().find(|entry| {
        let mut names: Vec<Option<&Value>> = vec![entry.get("id"), entry.get("label")];
        names.extend(array(entry.get("aliases")).iter().map(Some));
        names.into_iter().any(|value| normalized_token(value) == token)
    });
    if option.is_none() {
        errors.push(format!("{label}: выбран вариант вне PHB 2014"));
    }
    option
}

/// `languageFromContext(context)`: допустимые языки из контекста или `None`.
fn language_from_context(context: Option<&Value>) -> Option<Vec<String>> {
    let values = defined(prop(context, "language_options")).or_else(|| prop(context, "languages"));
    let Some(Value::Array(values)) = values else {
        return None;
    };
    let tokens = values
        .iter()
        .map(|entry| match entry {
            // В JS `null` здесь бросал `TypeError` (`typeof null === 'object'`).
            Value::Object(_) | Value::Array(_) | Value::Null => {
                normalized_token(defined(prop(Some(entry), "id")).or_else(|| prop(Some(entry), "value")))
            }
            other => normalized_token(Some(other)),
        })
        .filter(|token| !token.is_empty())
        .collect();
    Some(tokens)
}

fn validate_ranger_choices(choices: &Map<String, Value>, errors: &mut Vec<String>, context: Option<&Value>) -> Value {
    let raw_enemy = first_choice(choices, &["favored_enemy", "favoredEnemy"]);
    let enemy_object = raw_enemy.filter(|value| value.is_object());
    let synthesized = |key: &str| -> Option<&Value> {
        match key {
            "type" => first_choice(choices, &["favored_enemy_type", "favoredEnemyType"]),
            "races" => first_choice(choices, &["favored_enemy_races", "favoredEnemyRaces"]),
            "language" => first_choice(choices, &["favored_enemy_language", "favoredEnemyLanguage"]),
            _ => None,
        }
    };
    let field = |key: &str| -> Option<&Value> {
        match enemy_object {
            Some(enemy) => enemy.get(key),
            None => synthesized(key),
        }
    };
    let type_aliases: Vec<(&str, Vec<String>)> =
        FAVORED_ENEMY_TYPES.iter().map(|id| (*id, vec![id.strip_suffix('s').unwrap_or(id).to_string()])).collect();
    let enemy_type = canonical_from(defined(field("type")).or_else(|| field("enemy_type")), &FAVORED_ENEMY_TYPES, &type_aliases);
    let language = normalize_language(field("language"));
    if enemy_type.is_none() {
        errors.push("Избранный враг: выберите допустимый тип врага".into());
    }
    if let Some(enemy_type) = &enemy_type {
        if FAVORED_ENEMY_LANGUAGE_REQUIRED_TYPES.contains(&enemy_type.as_str()) && language.is_none() {
            errors.push("Избранный враг: для этого типа нужно указать язык, на котором говорят враги".into());
        }
    }
    let language_options = language_from_context(context);
    if let (Some(language), Some(options)) = (&language, &language_options) {
        if !options.contains(&token_of(language)) {
            errors.push("Избранный враг: язык отсутствует в каталоге доступных языков".into());
        }
    }
    let raw_races = defined(field("races")).or_else(|| defined(field("humanoid_races"))).or_else(|| field("humanoidRaces"));
    let races: Vec<String> = match raw_races {
        Some(Value::Array(items)) => {
            items.iter().map(|race| text::trim(&js::s(Some(race))).to_string()).filter(|race| !race.is_empty()).collect()
        }
        _ => Vec::new(),
    };
    if enemy_type.as_deref() == Some("humanoids") {
        let distinct = unique_strings(races.iter().map(|race| token_of(race))).len();
        if races.len() != 2 || distinct != 2 {
            errors.push("Избранный враг: для гуманоидов нужно выбрать две разные расы".into());
        }
    } else if !races.is_empty() {
        errors.push("Избранный враг: расы можно указывать только для гуманоидов".into());
    }
    json!({ "type": enemy_type, "races": races, "language": language })
}

fn validate_monk_tool_choice(choices: &Map<String, Value>, errors: &mut Vec<String>) -> Value {
    let raw = first_choice(choices, &["tool_or_instrument", "toolOrInstrument"]);
    let artisan = first_choice(choices, &["artisan_tool", "artisanTool"]);
    let instrument = first_choice(choices, &["instrument", "musical_instrument", "musicalInstrument"]);
    let supplied = [raw, artisan, instrument].iter().filter(|value| value.is_some()).count();
    if supplied != 1 {
        errors.push("Монах: выберите один ремесленный инструмент или один музыкальный инструмент".into());
        return Value::Null;
    }
    let artisan_choice = |id: Option<String>, errors: &mut Vec<String>| match id {
        Some(id) => json!({ "kind": "artisan_tool", "id": id }),
        None => {
            errors.push("Монах: выбран недопустимый ремесленный инструмент".into());
            Value::Null
        }
    };
    let instrument_choice = |id: Option<String>, errors: &mut Vec<String>| match id {
        Some(id) => json!({ "kind": "musical_instrument", "id": id }),
        None => {
            errors.push("Монах: выбран недопустимый музыкальный инструмент".into());
            Value::Null
        }
    };
    if let Some(raw) = raw {
        // `raw && typeof raw === 'object' ? raw : { id: raw }`.
        let is_object = matches!(raw, Value::Object(_) | Value::Array(_));
        let field = |key: &str| -> Option<&Value> {
            if is_object {
                prop(Some(raw), key)
            } else if key == "id" {
                Some(raw)
            } else {
                None
            }
        };
        let id = defined(field("id")).or_else(|| field("value"));
        let kind = normalized_token(defined(field("kind")).or_else(|| field("type")));
        let artisan_id = canonical_artisan_tool(id);
        let instrument_id = canonical_instrument(id);
        if kind.contains("artisan") || kind.contains("ремес") {
            return artisan_choice(artisan_id, errors);
        }
        if kind.contains("musical") || kind.contains("instrument") || kind.contains("музык") {
            return instrument_choice(instrument_id, errors);
        }
        match (artisan_id, instrument_id) {
            (Some(id), None) => return json!({ "kind": "artisan_tool", "id": id }),
            (None, Some(id)) => return json!({ "kind": "musical_instrument", "id": id }),
            _ => {}
        }
        errors.push("Монах: укажите вид выбранного инструмента".into());
        return Value::Null;
    }
    if artisan.is_some() {
        return artisan_choice(canonical_artisan_tool(artisan), errors);
    }
    instrument_choice(canonical_instrument(instrument), errors)
}

/// `contextProficiencies(context, selectedSkills, definition)`: владения,
/// которые уже есть у героя (для мастерства плута).
fn context_proficiencies(context: Option<&Value>, selected_skills: &[Option<String>], definition: &Value) -> Vec<Option<String>> {
    let mut normalized: Vec<Option<String>> = Vec::new();
    let mut add = |value: Option<String>| {
        if !normalized.contains(&value) {
            normalized.push(value);
        }
    };
    for skill in selected_skills {
        add(skill.clone());
    }
    for value in array(definition.get("tool_proficiencies")) {
        add(Some(js::s(Some(value))));
    }
    let explicit = ["proficiencies", "available_proficiencies", "skill_proficiencies", "tool_proficiencies"]
        .iter()
        .flat_map(|key| array(prop(context, key)).iter());
    for value in explicit {
        let value = Some(value);
        add(Some(
            canonical_skill(value)
                .or_else(|| canonical_artisan_tool(value))
                .or_else(|| canonical_instrument(value))
                .unwrap_or_else(|| normalized_token(value)),
        ));
    }
    normalized
}

/// Итог `validateChoices`: ошибки, нормализованные выборы и подкласс.
struct Validation {
    errors: Vec<String>,
    choices: Map<String, Value>,
    subclass: Option<&'static Value>,
}

fn opt_value(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::String)
}

fn validate_choices(class_key: &str, choices: Option<&Value>, context: Option<&Value>) -> Validation {
    let definition = definition(class_key);
    let mut errors: Vec<String> = Vec::new();
    let Some(Value::Object(choices)) = choices else {
        return Validation { errors: vec!["Классовые выборы должны быть объектом".into()], choices: Map::new(), subclass: None };
    };

    let skill_choice = definition.get("skill_choice");
    let skill_count = js::safe_int(prop(skill_choice, "count"), 0).max(0) as usize;
    let skill_options: Vec<String> = array(prop(skill_choice, "options")).iter().map(|entry| js::s(Some(entry))).collect();
    let selected_skills = exact_selection(
        first_choice(choices, &["skills", "class_skills", "classSkillProficiencies", "skill_proficiencies"]),
        skill_count,
        &skill_options,
        "Классовые навыки",
        &canonical_skill,
        &mut errors,
    );
    let mut normalized = Map::new();
    normalized.insert("skills".into(), selection_value(&selected_skills));

    if class_key == "bard" {
        let list = string_list(choices, &["instruments", "musical_instruments", "musicalInstruments"]);
        let instruments =
            exact_selection(Some(&list), 3, &strings(&MUSICAL_INSTRUMENTS), "Музыкальные инструменты", &canonical_instrument, &mut errors);
        normalized.insert("instruments".into(), selection_value(&instruments));
    }

    if class_key == "fighter" {
        let raw = first_choice(choices, &["fighting_style", "fightingStyle"]);
        let aliases: Vec<(&str, Vec<String>)> = vec![
            ("defense", strings(&["defence", "защита"])),
            ("dueling", strings(&["duelist", "дуэлянт"])),
            ("great_weapon_fighting", strings(&["great weapon", "сражение большим оружием"])),
            ("two_weapon_fighting", strings(&["two weapon", "сражение двумя оружиями"])),
            ("archery", strings(&["стрельба"])),
            ("protection", strings(&["оборона"])),
        ];
        let value = canonical_from(raw, &FIGHTING_STYLES, &aliases);
        if value.is_none() {
            errors.push("Боевой стиль: выберите один из шести вариантов PHB 2014".into());
        }
        normalized.insert("fighting_style".into(), opt_value(value));
    }

    if class_key == "monk" {
        let tool = validate_monk_tool_choice(choices, &mut errors);
        normalized.insert("tool_or_instrument".into(), tool);
    }

    if class_key == "rogue" {
        let available = context_proficiencies(context, &selected_skills, definition);
        let list = string_list(choices, &["expertise", "expertise_proficiencies", "expertiseProficiencies"]);
        let mut options = strings(&ALL_SKILLS);
        options.push("thieves_tools".into());
        let canonicalizer = |value: Option<&Value>| {
            canonical_skill(value).or_else(|| (normalized_token(value) == "thieves_tools").then(|| "thieves_tools".to_string()))
        };
        let expertise = exact_selection(Some(&list), 2, &options, "Мастерство", &canonicalizer, &mut errors);
        if expertise.iter().any(|value| !available.contains(value)) {
            errors.push("Мастерство: каждое выбранное владение должно уже принадлежать герою".into());
        }
        normalized.insert("expertise".into(), selection_value(&expertise));
    }

    if class_key == "ranger" {
        let enemy = validate_ranger_choices(choices, &mut errors, context);
        normalized.insert("favored_enemy".into(), enemy);
        let raw = first_choice(choices, &["natural_explorer", "natural_explorer_terrain", "naturalExplorer", "naturalExplorerTerrain"]);
        let aliases: Vec<(&str, Vec<String>)> = NATURAL_EXPLORER_TERRAINS.iter().map(|id| (*id, vec![id.to_string()])).collect();
        let terrain = canonical_from(raw, &NATURAL_EXPLORER_TERRAINS, &aliases);
        if terrain.is_none() {
            errors.push("Исследователь природы: выберите один тип предпочитаемой местности".into());
        }
        normalized.insert("natural_explorer".into(), opt_value(terrain));
    }

    let subclass = selected_subclass(definition, first_choice(choices, &["subclass", "domain", "origin", "patron"]), &mut errors);
    normalized.insert("subclass".into(), subclass.and_then(|entry| entry.get("id")).cloned().unwrap_or(Value::Null));

    if class_key == "cleric" {
        if let Some(subclass) = subclass {
            let subclass_id = subclass.get("id").and_then(Value::as_str);
            if subclass_id == Some("knowledge") {
                let list = string_list(choices, &["knowledge_skills", "knowledgeSkills"]);
                let options: Vec<String> =
                    array(subclass.pointer("/choices/knowledge_skills/options")).iter().map(|entry| js::s(Some(entry))).collect();
                let skills = exact_selection(Some(&list), 2, &options, "Домен знаний: навыки", &canonical_skill, &mut errors);
                normalized.insert("knowledge_skills".into(), selection_value(&skills));
                let languages: Vec<String> = array(Some(&string_list(choices, &["knowledge_languages", "knowledgeLanguages"])))
                    .iter()
                    .filter_map(|entry| normalize_language(Some(entry)))
                    .collect();
                if languages.len() != 2 {
                    errors.push("Домен знаний: нужно выбрать два языка".into());
                }
                if unique_strings(languages.iter().map(|language| token_of(language))).len() != languages.len() {
                    errors.push("Домен знаний: языки нельзя повторять".into());
                }
                normalized.insert("knowledge_languages".into(), str_array(&languages));
            }
            if subclass_id == Some("nature") {
                let cantrip = canonical_from(
                    first_choice(choices, &["nature_cantrip", "druid_cantrip", "natureCantrip", "druidCantrip"]),
                    &DRUID_CANTRIPS,
                    &spelled_aliases(&DRUID_CANTRIPS),
                );
                let skill = canonical_from(
                    first_choice(choices, &["nature_skill", "natureSkill"]),
                    &["animal_handling", "nature", "survival"],
                    &[("animal_handling", strings(&["animal handling", "уход за животными"]))],
                );
                if cantrip.is_none() {
                    errors.push("Домен природы: выберите один заговор друида PHB 2014".into());
                }
                if skill.is_none() {
                    errors.push("Домен природы: выберите один навык из трёх вариантов".into());
                }
                normalized.insert("nature_cantrip".into(), opt_value(cantrip));
                normalized.insert("nature_skill".into(), opt_value(skill));
            }
        }
    }

    if class_key == "sorcerer" && subclass.and_then(|entry| entry.get("id")).and_then(Value::as_str) == Some("draconic-bloodline") {
        let ids: Vec<&str> = DRACONIC_ANCESTRIES.iter().map(|(id, _, _)| *id).collect();
        let aliases: Vec<(&str, Vec<String>)> = DRACONIC_ANCESTRIES.iter().map(|(id, label, _)| (*id, vec![label.to_string()])).collect();
        let ancestry = canonical_from(first_choice(choices, &["draconic_ancestry", "ancestry", "draconicAncestry"]), &ids, &aliases);
        if ancestry.is_none() {
            errors.push("Драконий предок: выберите один цвет дракона PHB 2014".into());
        }
        normalized.insert("draconic_ancestry".into(), opt_value(ancestry));
    }

    Validation { errors, choices: normalized, subclass }
}

/// `[...new Set(values)]` над строковыми значениями JSON.
fn unique_value_strings<'a>(values: impl IntoIterator<Item = &'a Value>) -> Value {
    Value::Array(crate::support::unique_values(values.into_iter().cloned()))
}

fn build_benefits(class_key: &str, choices: &Map<String, Value>, subclass: Option<&'static Value>) -> Value {
    let definition = definition(class_key);
    let field = |key: &str| prop(subclass, key);
    let armor = unique_value_strings(array(definition.get("armor_proficiencies")).iter().chain(array(field("additional_armor_proficiencies"))));
    let weapons =
        unique_value_strings(array(definition.get("weapon_proficiencies")).iter().chain(array(field("additional_weapon_proficiencies"))));
    let tool_choice_id = prop(choices.get("tool_or_instrument"), "id").filter(|id| js::truthy(Some(id)));
    let tools = unique_value_strings(
        array(definition.get("tool_proficiencies")).iter().chain(array(choices.get("instruments"))).chain(tool_choice_id),
    );
    let nature_skill = choices.get("nature_skill").filter(|skill| js::truthy(Some(skill)));
    let skills = unique_value_strings(array(choices.get("skills")).iter().chain(array(choices.get("knowledge_skills"))).chain(nature_skill));
    let subclass_id = field("id").and_then(Value::as_str);
    let selected_subclass = subclass.map(|subclass| {
        json!({
            "id": subclass.get("id").cloned().unwrap_or(Value::Null),
            "label": subclass.get("label").cloned().unwrap_or(Value::Null),
            "features": defined(subclass.get("features")).cloned().unwrap_or_else(|| json!([])),
            "domain_spells": defined(subclass.get("domain_spells")).cloned().unwrap_or(Value::Null),
            "expanded_spell_list": defined(subclass.get("expanded_spell_list")).cloned().unwrap_or(Value::Null),
        })
    });
    let expertise = match defined(choices.get("expertise")) {
        Some(expertise) => Value::Array(array(Some(expertise)).to_vec()),
        None if js::truthy(choices.get("knowledge_skills")) && subclass_id == Some("knowledge") => {
            Value::Array(array(choices.get("knowledge_skills")).to_vec())
        }
        None => json!([]),
    };
    let features: Vec<Value> = array(definition.get("features"))
        .iter()
        .chain(if js::truthy(field("features")) { array(field("features")) } else { &[] })
        .cloned()
        .collect();
    let mut benefits = Map::new();
    benefits.insert("class_key".into(), json!(class_key));
    benefits.insert("level".into(), json!(1));
    benefits.insert("hit_die".into(), definition.get("hit_die").cloned().unwrap_or(Value::Null));
    benefits.insert("primary_abilities".into(), Value::Array(array(definition.get("primary_abilities")).to_vec()));
    benefits.insert("saving_throw_proficiencies".into(), Value::Array(array(definition.get("saving_throw_proficiencies")).to_vec()));
    benefits.insert("armor_proficiencies".into(), armor);
    benefits.insert("armor_restrictions".into(), Value::Array(array(definition.get("armor_restrictions")).to_vec()));
    benefits.insert("weapon_proficiencies".into(), weapons);
    benefits.insert("tool_proficiencies".into(), tools);
    benefits.insert("skill_proficiencies".into(), skills);
    benefits.insert("expertise".into(), expertise);
    benefits.insert("features".into(), Value::Array(features));
    benefits.insert("spellcasting".into(), definition.get("spellcasting").cloned().unwrap_or(Value::Null));
    benefits.insert("subclass".into(), selected_subclass.unwrap_or(Value::Null));
    benefits.insert("choices".into(), Value::Object(choices.clone()));
    benefits.insert(
        "source_url".into(),
        DND_SU_CLASS_SOURCES.iter().find(|(key, _)| *key == class_key).map_or(Value::Null, |(_, url)| json!(url)),
    );
    if let Some(choice) = choices.get("tool_or_instrument").filter(|choice| js::truthy(Some(choice))) {
        benefits.insert("tool_choice".into(), choice.clone());
    }
    if let Some(style) = choices.get("fighting_style").filter(|style| js::truthy(Some(style))) {
        benefits.insert("fighting_style".into(), style.clone());
    }
    if let Some(expertise) = choices.get("expertise").filter(|expertise| js::truthy(Some(expertise))) {
        benefits.insert("expertise".into(), Value::Array(array(Some(expertise)).to_vec()));
    }
    if let Some(enemy) = choices.get("favored_enemy").filter(|enemy| js::truthy(Some(enemy))) {
        benefits.insert("favored_enemy".into(), enemy.clone());
        let language = enemy.get("language").filter(|language| js::truthy(Some(language)));
        benefits.insert("languages".into(), Value::Array(language.cloned().into_iter().collect()));
    }
    if let Some(terrain) = choices.get("natural_explorer").filter(|terrain| js::truthy(Some(terrain))) {
        benefits.insert("natural_explorer".into(), terrain.clone());
    }
    if let Some(languages) = choices.get("knowledge_languages").filter(|languages| js::truthy(Some(languages))) {
        benefits.insert("languages".into(), Value::Array(array(Some(languages)).to_vec()));
    }
    if let Some(cantrip) = choices.get("nature_cantrip").filter(|cantrip| js::truthy(Some(cantrip))) {
        benefits.insert("extra_druid_cantrip".into(), cantrip.clone());
    }
    if let Some(ancestry) = choices.get("draconic_ancestry").and_then(Value::as_str).filter(|ancestry| !ancestry.is_empty()) {
        let mut entry = Map::new();
        entry.insert("id".into(), json!(ancestry));
        if let Some(Value::Object(details)) = PHB_2014_DRACONIC_ANCESTRIES.get(ancestry) {
            entry.extend(details.clone());
        }
        benefits.insert("draconic_ancestry".into(), Value::Object(entry));
        benefits.insert("languages".into(), json!(["draconic"]));
        benefits.insert("max_hit_points_bonus".into(), json!(1));
        benefits.insert("max_hit_points_bonus_per_class_level".into(), json!(1));
        benefits.insert("unarmored_armor_class".into(), json!({ "base": 13, "dexterity_modifier": true }));
    }
    if let Some(domain_spells) = field("domain_spells").filter(|spells| js::truthy(Some(spells))) {
        benefits.insert("domain_spells".into(), domain_spells.clone());
        benefits.insert("domain_spell_ids".into(), Value::Array(array(prop(Some(domain_spells), "1")).to_vec()));
        let by_level: Map<String, Value> = match domain_spells {
            Value::Object(levels) => js::entries(levels)
                .into_iter()
                .filter(|(level, _)| text::test(re!(r"^\d+$", "u"), level))
                .map(|(level, ids)| (level.clone(), Value::Array(crate::support::spread_items(Some(ids)))))
                .collect(),
            _ => Map::new(),
        };
        benefits.insert("domain_spell_ids_by_level".into(), Value::Object(crate::support::js_ordered(by_level)));
        benefits.insert("domain_spells_always_prepared".into(), json!(true));
        benefits.insert("domain_spells_count_against_prepared_limit".into(), json!(false));
    }
    if let Some(list) = field("expanded_spell_list").filter(|list| js::truthy(Some(list))) {
        benefits.insert("expanded_spell_list".into(), list.clone());
    }
    Value::Object(benefits)
}

/// `classOptionFor(classKey)`: копия определения класса PHB 2014 или `None`.
pub fn class_option_for(class_key: Option<&Value>) -> Option<Value> {
    canonical_class_key(class_key).map(|key| definition(key).clone())
}

/// `classOptionsCatalog()`: полный каталог двенадцати базовых классов.
pub fn class_options_catalog() -> Value {
    Value::Array(PHB_2014_CLASS_KEYS.iter().map(|key| definition(key).clone()).collect())
}

/// `classCreationOptionsCatalog()`: каталог классов с редакцией и книгой.
pub fn class_creation_options_catalog() -> Value {
    json!({
        "ruleset_id": CLASS_OPTIONS_PROVENANCE["ruleset_id"],
        "edition_family": CLASS_OPTIONS_PROVENANCE["edition_family"],
        "source_book": CLASS_OPTIONS_PROVENANCE["source_book"],
        "classes": class_options_catalog(),
    })
}

/// `validateClassChoices(classKey, choices = {}, context = {})`. `choices`
/// `None` — не передан (`{}`), `Some(null)` — явный `null` (ошибка).
/// `context.proficiencies` нужен плуту: мастерство — только для уже
/// полученного навыка или инструмента.
pub fn validate_class_choices(class_key: Option<&Value>, choices: Option<&Value>, context: Option<&Value>) -> Value {
    let Some(key) = canonical_class_key(class_key) else {
        return json!({ "ok": false, "code": "CLASS_UNSUPPORTED", "errors": ["Неизвестный класс PHB 2014"] });
    };
    let empty = Value::Object(Map::new());
    let result = validate_choices(key, Some(choices.unwrap_or(&empty)), context);
    if let Some(first) = result.errors.first() {
        return json!({ "ok": false, "code": "CLASS_CHOICES_INVALID", "class_key": key, "errors": result.errors, "error": first });
    }
    let benefits = build_benefits(key, &result.choices, result.subclass);
    json!({ "ok": true, "class_key": key, "choices": result.choices, "benefits": benefits })
}

/// `classBenefitsFor(classKey, choices, context)`: проверенные преимущества
/// класса поверх краткой копии результата проверки.
pub fn class_benefits_for(class_key: Option<&Value>, choices: Option<&Value>, context: Option<&Value>) -> Value {
    let result = validate_class_choices(class_key, choices, context);
    if !js::is_true(result.get("ok")) {
        return result;
    }
    let mut merged = match &result {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    crate::support::spread_into(&mut merged, result.get("benefits"));
    Value::Object(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skills_for(class_key: &str) -> Value {
        let option = class_option_for(Some(&json!(class_key))).unwrap_or(Value::Null);
        let count = option["skill_choice"]["count"].as_u64().unwrap_or(0) as usize;
        Value::Array(array(option["skill_choice"].get("options")).iter().take(count).cloned().collect())
    }

    fn benefits(class_key: &str, choices: Value) -> Value {
        class_benefits_for(Some(&json!(class_key)), Some(&choices), None)
    }

    #[test]
    fn catalog_has_exactly_12_phb_classes() {
        let catalog = class_options_catalog();
        let ids: Vec<&str> = array(Some(&catalog)).iter().filter_map(|entry| entry["id"].as_str()).collect();
        assert_eq!(ids, PHB_2014_CLASS_KEYS);
        let option = |key: &str| class_option_for(Some(&json!(key))).unwrap_or(Value::Null);
        assert_eq!(option("fighter")["armor_proficiencies"], json!(["light", "medium", "heavy", "shields"]));
        assert_eq!(option("druid")["tool_proficiencies"], json!(["herbalism_kit"]));
        assert_eq!(option("rogue")["tool_proficiencies"], json!(["thieves_tools"]));
        assert_eq!(option("sorcerer")["saving_throw_proficiencies"], json!(["con", "cha"]));
        assert_eq!(option("druid")["armor_restrictions"][0], json!("nonmetal"));
    }

    #[test]
    fn first_level_subclasses_only_for_cleric_sorcerer_warlock() {
        let ids = |key: &str| -> Vec<Value> {
            array(class_option_for(Some(&json!(key))).unwrap_or(Value::Null).get("subclass_options")).iter().map(|entry| entry["id"].clone()).collect()
        };
        assert_eq!(ids("cleric"), [json!("knowledge"), json!("life"), json!("light"), json!("nature"), json!("tempest"), json!("trickery"), json!("war")]);
        assert_eq!(ids("sorcerer"), [json!("draconic-bloodline"), json!("wild-magic")]);
        assert_eq!(ids("warlock"), [json!("archfey"), json!("fiend"), json!("great-old-one")]);
        assert!(ids("bard").is_empty());
        assert_eq!(benefits("cleric", json!({ "skills": skills_for("cleric"), "subclass": "forge" }))["ok"], json!(false));
    }

    #[test]
    fn bard_instruments_and_monk_tool() {
        let bard = benefits("bard", json!({ "skills": ["performance", "persuasion", "history"], "instruments": ["lute", "drum", "bagpipes"] }));
        assert_eq!(bard["ok"], json!(true));
        assert_eq!(bard["tool_proficiencies"], json!(["lute", "drum", "bagpipes"]));
        assert_eq!(benefits("bard", json!({ "skills": skills_for("bard"), "instruments": ["lute", "lute", "drum"] }))["ok"], json!(false));
        let monk = benefits("monk", json!({ "skills": ["acrobatics", "stealth"], "artisan_tool": "smiths_tools" }));
        assert_eq!(monk["ok"], json!(true));
        assert_eq!(monk["tool_proficiencies"], json!(["smiths_tools"]));
        let musical = json!({ "skills": ["acrobatics", "stealth"], "tool_or_instrument": { "kind": "musical_instrument", "id": "lute" } });
        assert_eq!(benefits("monk", musical)["ok"], json!(true));
        assert_eq!(benefits("monk", json!({ "skills": ["acrobatics", "stealth"] }))["ok"], json!(false));
    }

    #[test]
    fn rogue_expertise_needs_existing_proficiency() {
        let valid = benefits("rogue", json!({ "skills": ["stealth", "perception", "investigation", "deception"], "expertise": ["stealth", "thieves-tools"] }));
        assert_eq!(valid["ok"], json!(true));
        assert_eq!(valid["expertise"], json!(["stealth", "thieves_tools"]));
        let foreign = json!({ "skills": ["stealth", "perception", "investigation", "deception"], "expertise": ["arcana", "thieves_tools"] });
        assert_eq!(benefits("rogue", foreign.clone())["ok"], json!(false));
        let context = json!({ "proficiencies": ["arcana"] });
        assert_eq!(class_benefits_for(Some(&json!("rogue")), Some(&foreign), Some(&context))["ok"], json!(true));
    }

    #[test]
    fn draconic_bloodline_gives_damage_language_hit_points_and_armor() {
        let sorcerer = benefits("sorcerer", json!({ "skills": ["arcana", "persuasion"], "subclass": "draconic-bloodline", "draconic_ancestry": "red" }));
        assert_eq!(sorcerer["ok"], json!(true));
        assert_eq!(sorcerer["draconic_ancestry"], json!({ "id": "red", "label": "Красный", "damage_type": "fire" }));
        assert_eq!(sorcerer["languages"], json!(["draconic"]));
        assert_eq!(sorcerer["max_hit_points_bonus_per_class_level"], json!(1));
        assert_eq!(sorcerer["unarmored_armor_class"], json!({ "base": 13, "dexterity_modifier": true }));
        assert_eq!(PHB_2014_DRACONIC_ANCESTRIES.as_object().map(Map::len), Some(10));
    }

    #[test]
    fn tool_catalog_is_complete() {
        let kinds = |kind: &str| array(Some(&PHB_2014_TOOL_CATALOG)).iter().filter(|entry| entry["kind"] == json!(kind)).count();
        assert_eq!(kinds("artisan_tool"), 17);
        assert_eq!(kinds("musical_instrument"), 10);
        assert_eq!(kinds("gaming_set"), 4);
        assert_eq!(kinds("other_tool"), 8);
    }
}

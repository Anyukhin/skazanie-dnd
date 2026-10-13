//! Перенос `server/character-creation-feats.mjs`: черты PHB 2014 при создании
//! героя — каталог, проверка выбора и производные преимущества, которые
//! безопасно класть на лист. Боевые обработчики читают `benefits.static`, но
//! сюда не импортируются; книги после PHB и черты происхождения 2024 сюда не
//! относятся.

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::{js, text};

use crate::support::{array, defined, includes_str, prop};

/// `PHB_2014_FEATS_SOURCE`: книга и ссылки источника черт.
pub static PHB_2014_FEATS_SOURCE: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "edition": "D&D 5e 2014",
        "book": "Player's Handbook",
        "source": "PHB2014",
        "source_url": "https://5e14.dnd.su/feats/",
        "official_rules_url": "https://www.dndbeyond.com/sources/dnd/basic-rules-2014/customization-options",
    })
});

pub const ABILITY_IDS: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];

const SPELLCASTING_CLASSES: &[&str] = &["bard", "cleric", "druid", "sorcerer", "warlock", "wizard"];
const SPELLCASTING_ABILITY: &[(&str, &str)] =
    &[("bard", "cha"), ("cleric", "wis"), ("druid", "wis"), ("sorcerer", "cha"), ("warlock", "cha"), ("wizard", "int")];
const ELEMENTAL_DAMAGE_TYPES: &[&str] = &["acid", "cold", "fire", "lightning", "thunder"];

const SKILLS: &[&str] = &[
    "acrobatics", "animal_handling", "arcana", "athletics", "deception", "history", "insight", "intimidation", "investigation", "medicine",
    "nature", "perception", "performance", "persuasion", "religion", "sleight_of_hand", "stealth", "survival",
];

// Владения инструментами PHB. На входе принимаются и id проекта, и обычное
// написание SRD; результат держит один стабильный snake_case id.
const TOOLS: &[&str] = &[
    "alchemists_supplies", "brewers_supplies", "calligraphers_supplies", "carpenters_tools",
    "cartographers_tools", "cobblers_tools", "cooks_utensils", "glassblowers_tools",
    "jewelers_tools", "leatherworkers_tools", "masons_tools", "painters_supplies",
    "potters_tools", "smiths_tools", "tinkers_tools", "weavers_tools", "woodcarvers_tools",
    "disguise_kit", "forgery_kit", "herbalism_kit", "navigators_tools", "poisoners_kit",
    "thieves_tools", "dice_set", "dragonchess_set", "playing_card_set", "playing_cards", "three_dragon_ante_set",
    "bagpipes", "drum", "dulcimer", "flute", "lute", "lyre", "horn", "pan_flute", "shawm", "viol",
    "land_vehicles", "water_vehicles", "vehicles_land", "vehicles_water",
];

const LANGUAGES: &[&str] = &[
    "common", "dwarvish", "elvish", "giant", "gnomish", "goblin", "halfling", "orc", "abyssal", "celestial", "draconic", "deep_speech",
    "infernal", "primordial", "sylvan", "undercommon",
];

const WEAPONS: &[&str] = &[
    "club", "dagger", "greatclub", "handaxe", "javelin", "light_hammer", "mace", "quarterstaff",
    "sickle", "spear", "light_crossbow", "dart", "shortbow", "sling",
    "battleaxe", "flail", "glaive", "greataxe", "greatsword", "halberd", "lance", "longsword",
    "maul", "morningstar", "pike", "rapier", "scimitar", "shortsword", "trident", "war_pick",
    "warhammer", "whip", "hand_crossbow", "heavy_crossbow", "longbow", "net", "blowgun",
];

/// Список заклинаний класса: `(класс, id заклинаний)`.
pub type ClassSpellList = (&'static str, &'static [&'static str]);

/// `PHB_CANTRIPS`: заговоры PHB 2014 по классам.
pub const PHB_CANTRIPS: [ClassSpellList; 6] = [
    ("bard", &["blade-ward", "dancing-lights", "friends", "light", "mage-hand", "mending", "message", "minor-illusion", "prestidigitation", "true-strike", "vicious-mockery"]),
    ("cleric", &["guidance", "light", "mending", "resistance", "sacred-flame", "spare-the-dying", "thaumaturgy"]),
    ("druid", &["druidcraft", "guidance", "mending", "poison-spray", "produce-flame", "resistance", "shillelagh", "thorn-whip"]),
    ("sorcerer", &["acid-splash", "blade-ward", "chill-touch", "dancing-lights", "fire-bolt", "friends", "light", "mage-hand", "mending", "message", "minor-illusion", "poison-spray", "prestidigitation", "ray-of-frost", "shocking-grasp", "true-strike"]),
    ("warlock", &["blade-ward", "chill-touch", "eldritch-blast", "friends", "mage-hand", "minor-illusion", "poison-spray", "prestidigitation", "true-strike"]),
    ("wizard", &["acid-splash", "blade-ward", "chill-touch", "dancing-lights", "fire-bolt", "friends", "light", "mage-hand", "mending", "message", "minor-illusion", "poison-spray", "prestidigitation", "ray-of-frost", "shocking-grasp", "true-strike"]),
];

/// `PHB_FIRST_LEVEL_SPELLS`: заклинания 1 круга PHB 2014 по классам.
pub const PHB_FIRST_LEVEL_SPELLS: [ClassSpellList; 6] = [
    ("bard", &[
        "animal-friendship", "bane", "charm-person", "comprehend-languages", "cure-wounds", "detect-magic",
        "disguise-self", "dissonant-whispers", "faerie-fire", "feather-fall", "healing-word", "heroism",
        "tasha-s-hideous-laughter", "identify", "illusory-script", "longstrider", "silent-image", "sleep",
        "speak-with-animals", "thunderwave", "unseen-servant",
    ]),
    ("cleric", &[
        "bane", "bless", "command", "create-or-destroy-water", "cure-wounds", "detect-evil-and-good",
        "detect-magic", "detect-poison-and-disease", "guiding-bolt", "healing-word", "inflict-wounds",
        "protection-from-evil-and-good", "purify-food-and-drink", "sanctuary", "shield-of-faith",
    ]),
    ("druid", &[
        "animal-friendship", "charm-person", "create-or-destroy-water", "cure-wounds", "detect-magic", "detect-poison-and-disease",
        "entangle", "faerie-fire", "fog-cloud", "goodberry", "healing-word", "jump", "longstrider",
        "purify-food-and-drink", "speak-with-animals", "thunderwave",
    ]),
    ("sorcerer", &[
        "burning-hands", "charm-person", "chromatic-orb", "color-spray", "comprehend-languages", "detect-magic",
        "disguise-self", "expeditious-retreat", "false-life", "feather-fall", "fog-cloud", "jump", "mage-armor", "magic-missile",
        "ray-of-sickness", "shield", "silent-image", "sleep", "thunderwave", "witch-bolt",
    ]),
    ("warlock", &[
        "armor-of-agathys", "arms-of-hadar", "charm-person", "comprehend-languages", "expeditious-retreat",
        "hellish-rebuke", "hex", "illusory-script", "protection-from-evil-and-good", "unseen-servant", "witch-bolt",
    ]),
    ("wizard", &[
        "alarm", "burning-hands", "charm-person", "chromatic-orb", "comprehend-languages", "detect-magic",
        "color-spray", "disguise-self", "expeditious-retreat", "false-life", "feather-fall", "find-familiar", "fog-cloud",
        "grease", "identify", "illusory-script", "jump", "longstrider", "mage-armor", "magic-missile", "protection-from-evil-and-good",
        "ray-of-sickness", "shield", "silent-image", "sleep", "tasha-s-hideous-laughter", "tenser-s-floating-disk",
        "thunderwave", "unseen-servant",
    ]),
];

/// `PHB_RITUALS`: ритуалы 1 круга PHB 2014 по классам.
pub const PHB_RITUALS: [ClassSpellList; 6] = [
    ("bard", &["comprehend-languages", "detect-magic", "identify", "illusory-script", "speak-with-animals", "unseen-servant"]),
    ("cleric", &["detect-magic", "detect-poison-and-disease", "purify-food-and-drink"]),
    ("druid", &["detect-magic", "detect-poison-and-disease", "purify-food-and-drink", "speak-with-animals"]),
    ("sorcerer", &["comprehend-languages", "detect-magic"]),
    ("warlock", &["comprehend-languages", "detect-magic", "illusory-script", "unseen-servant"]),
    ("wizard", &["alarm", "comprehend-languages", "detect-magic", "find-familiar", "identify", "illusory-script", "tenser-s-floating-disk", "unseen-servant"]),
];

const SPELL_SNIPER_CANTRIPS: [ClassSpellList; 6] = [
    ("bard", &[]),
    ("cleric", &[]),
    ("druid", &["produce-flame", "thorn-whip"]),
    ("sorcerer", &["chill-touch", "fire-bolt", "ray-of-frost", "shocking-grasp"]),
    ("warlock", &["chill-touch", "eldritch-blast"]),
    ("wizard", &["chill-touch", "fire-bolt", "ray-of-frost", "shocking-grasp"]),
];

/// Список класса из таблицы `PHB_CANTRIPS`, `PHB_FIRST_LEVEL_SPELLS`,
/// `PHB_RITUALS` (`TABLE[classKey]`).
pub fn class_spell_list(table: &[ClassSpellList], class_key: &str) -> Option<&'static [&'static str]> {
    table.iter().find(|(key, _)| *key == class_key).map(|(_, list)| *list)
}

const SPELL_ID_ALIASES: &[(&str, &str)] = &[
    ("tasha's-hideous-laughter", "tasha-s-hideous-laughter"),
    ("tashas-hideous-laughter", "tasha-s-hideous-laughter"),
    ("tenser’s-floating-disk", "tenser-s-floating-disk"),
    ("tenser's-floating-disk", "tenser-s-floating-disk"),
];

const TOKEN_ALIASES: &[(&str, &str)] = &[
    ("animal-handling", "animal_handling"), ("sleight-of-hand", "sleight_of_hand"),
    ("alchemist-s-supplies", "alchemists_supplies"), ("alchemist’s-supplies", "alchemists_supplies"),
    ("brewer-s-supplies", "brewers_supplies"), ("brewer’s-supplies", "brewers_supplies"),
    ("calligrapher-s-supplies", "calligraphers_supplies"), ("calligrapher’s-supplies", "calligraphers_supplies"),
    ("carpenter-s-tools", "carpenters_tools"), ("carpenter’s-tools", "carpenters_tools"),
    ("cartographer-s-tools", "cartographers_tools"), ("cartographer’s-tools", "cartographers_tools"),
    ("cobbler-s-tools", "cobblers_tools"), ("cobbler’s-tools", "cobblers_tools"),
    ("cook-s-utensils", "cooks_utensils"), ("cook’s-utensils", "cooks_utensils"),
    ("glassblower-s-tools", "glassblowers_tools"), ("glassblower’s-tools", "glassblowers_tools"),
    ("jeweler-s-tools", "jewelers_tools"), ("jeweler’s-tools", "jewelers_tools"),
    ("leatherworker-s-tools", "leatherworkers_tools"), ("leatherworker’s-tools", "leatherworkers_tools"),
    ("mason-s-tools", "masons_tools"), ("mason’s-tools", "masons_tools"),
    ("painter-s-supplies", "painters_supplies"), ("painter’s-supplies", "painters_supplies"),
    ("potter-s-tools", "potters_tools"), ("potter’s-tools", "potters_tools"),
    ("smith-s-tools", "smiths_tools"), ("smith’s-tools", "smiths_tools"),
    ("tinker-s-tools", "tinkers_tools"), ("tinker’s-tools", "tinkers_tools"),
    ("weaver-s-tools", "weavers_tools"), ("weaver’s-tools", "weavers_tools"),
    ("woodcarver-s-tools", "woodcarvers_tools"), ("woodcarver’s-tools", "woodcarvers_tools"),
    ("disguise-kit", "disguise_kit"), ("forgery-kit", "forgery_kit"), ("herbalism-kit", "herbalism_kit"),
    ("navigators-tools", "navigators_tools"), ("poisoners-kit", "poisoners_kit"), ("thieves-tools", "thieves_tools"),
    ("land-vehicles", "land_vehicles"), ("water-vehicles", "water_vehicles"),
    ("playing-cards", "playing_card_set"),
    ("hand-crossbow", "hand_crossbow"), ("light-crossbow", "light_crossbow"), ("heavy-crossbow", "heavy_crossbow"),
    ("great-club", "greatclub"), ("light-hammer", "light_hammer"), ("quarter-staff", "quarterstaff"),
    ("short-bow", "shortbow"), ("battle-axe", "battleaxe"), ("great-axe", "greataxe"), ("great-sword", "greatsword"),
    ("long-sword", "longsword"), ("morning-star", "morningstar"), ("war-pick", "war_pick"), ("war-hammer", "warhammer"),
    ("deep-speech", "deep_speech"),
];

pub const PHB_MARTIAL_ADEPT_MANEUVER_IDS: [&str; 16] = [
    "commander-s-strike", "disarming-attack", "distracting-strike", "evasive-footwork",
    "feinting-attack", "goading-attack", "lunging-attack", "maneuvering-attack",
    "menacing-attack", "parry", "precision-attack", "pushing-attack", "rally",
    "riposte", "sweeping-attack", "trip-attack",
];

fn lookup<T: Copy>(table: &[(&str, T)], key: &str) -> Option<T> {
    table.iter().find(|(candidate, _)| *candidate == key).map(|(_, value)| *value)
}

/// `/\s/u` JS: пробельные символы и переводы строки (без U+0085, с U+FEFF).
fn is_regex_space(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}'
            | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// Заменить каждую серию подходящих символов одним `-` (`replace(/[…]+/gu, '-')`).
fn squash_runs(text: &str, matches: impl Fn(char) -> bool) -> String {
    let mut result = String::with_capacity(text.len());
    let mut in_run = false;
    for ch in text.chars() {
        if matches(ch) {
            if !in_run {
                result.push('-');
            }
            in_run = true;
        } else {
            in_run = false;
            result.push(ch);
        }
    }
    result
}

/// `token(value)`: NFKC, без пробелов по краям, нижний регистр, пробелы,
/// `_` и `—` — дефисы.
fn token(value: Option<&Value>) -> String {
    let base = text::lower(text::trim(&text::nfkc(&js::s(value))));
    squash_runs(&base, is_regex_space).replace(['_', '—'], "-")
}

/// `canonicalToken(value)`: псевдоним из `TOKEN_ALIASES` либо токен с `_`
/// вместо `-`.
fn canonical_token(value: Option<&Value>) -> String {
    let raw = token(value);
    lookup(TOKEN_ALIASES, &raw).map(str::to_string).unwrap_or_else(|| raw.replace('-', "_"))
}

fn canonical_spell_id(value: Option<&Value>) -> String {
    let raw = token(value);
    lookup(SPELL_ID_ALIASES, &raw).map(str::to_string).unwrap_or(raw)
}

fn maneuver_token(value: Option<&Value>) -> String {
    let base = text::lower(text::trim(&text::nfkc(&js::s(value))));
    squash_runs(&base, |ch| is_regex_space(ch) || ch == '_')
}

/// Отказ проверки выбора: код и текст.
type Refusal = (&'static str, String);

/// Выбор ровно `count` разных непустых значений (`exactArray`, `spellArray`,
/// `maneuverArray` — различаются только нормализацией).
fn exact_list(value: Option<&Value>, count: usize, label: &str, normalize: fn(Option<&Value>) -> String) -> Result<Vec<String>, Refusal> {
    let items = match value {
        Some(Value::Array(items)) if items.len() == count => items,
        _ => return Err(("CHOICE_COUNT_INVALID", format!("{label}: нужно выбрать {count}"))),
    };
    let result: Vec<String> = items.iter().map(|item| normalize(Some(item))).collect();
    if result.iter().any(String::is_empty) {
        return Err(("CHOICE_INVALID", format!("{label}: выбор не может быть пустым")));
    }
    if crate::support::unique_strings(result.iter().cloned()).len() != result.len() {
        return Err(("CHOICE_DUPLICATE", format!("{label}: варианты не должны повторяться")));
    }
    Ok(result)
}

fn has_own(object: Option<&Value>, key: &str) -> bool {
    match object {
        Some(Value::Object(map)) => map.contains_key(key),
        Some(Value::Array(items)) => js::is_array_index_key(key) && key.parse::<usize>().is_ok_and(|index| index < items.len()),
        _ => false,
    }
}

/// `choiceValue(choices, names)`: значение первого собственного поля из списка.
fn choice_value<'a>(choices: &'a Map<String, Value>, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| choices.get(*name))
}

fn prerequisites(id: &str) -> Value {
    let dex13 = json!({ "kind": "ability", "ability": "dex", "minimum": 13, "label": "Ловкость 13 или выше" });
    let spellcasting = json!({ "kind": "spellcasting", "label": "Умение накладывать хотя бы одно заклинание" });
    let medium = json!({ "kind": "proficiency", "category": "armor", "value": "medium", "label": "Владение средними доспехами" });
    match id {
        "defensive-duelist" => json!([dex13]),
        "elemental-adept" => json!([spellcasting]),
        "grappler" => json!([{ "kind": "ability", "ability": "str", "minimum": 13, "label": "Сила 13 или выше" }]),
        "heavily-armored" => json!([medium]),
        "heavy-armor-master" => json!([{ "kind": "proficiency", "category": "armor", "value": "heavy", "label": "Владение тяжёлыми доспехами" }]),
        "inspiring-leader" => json!([{ "kind": "ability", "ability": "cha", "minimum": 13, "label": "Харизма 13 или выше" }]),
        "medium-armor-master" => json!([medium]),
        "moderately-armored" => json!([{ "kind": "proficiency", "category": "armor", "value": "light", "label": "Владение лёгкими доспехами" }]),
        "ritual-caster" => json!([{ "kind": "ability_any", "abilities": ["int", "wis"], "minimum": 13, "label": "Интеллект или Мудрость 13 или выше" }]),
        "skulker" => json!([dex13]),
        "spell-sniper" => json!([spellcasting]),
        "war-caster" => json!([spellcasting]),
        _ => json!([]),
    }
}

fn ability_choices(id: &str) -> Option<&'static [&'static str]> {
    match id {
        "athlete" | "lightly-armored" | "moderately-armored" => Some(&["str", "dex"]),
        "observant" => Some(&["int", "wis"]),
        "resilient" => Some(&ABILITY_IDS),
        "tavern-brawler" => Some(&["str", "con"]),
        _ => None,
    }
}

fn static_benefits(id: &str) -> Option<Value> {
    let value = match id {
        "actor" => json!({ "advantage_on_deception_performance_disguise": true, "mimic_speech_and_sounds": true, "mimic_listen_minutes": 1 }),
        "alert" => json!({ "cannot_be_surprised_while_conscious": true, "unseen_attackers_do_not_gain_advantage": true }),
        "athlete" => json!({ "stand_from_prone_cost_feet": 5, "climbing_uses_no_extra_movement": true, "running_jump_start_feet": 5 }),
        "charger" => json!({ "charge_distance_feet": 10, "charge_bonus_action": true, "charge_attack_damage_bonus": 5, "charge_shove": true }),
        "crossbow-expert" => json!({ "ignore_loading_property": true, "ranged_attacks_in_melee_no_disadvantage": true, "bonus_action_hand_crossbow_after_one_handed_attack": true }),
        "defensive-duelist" => json!({ "reaction_ac_bonus": "proficiency_bonus", "trigger": "melee_attack_hit", "weapon_property": "finesse" }),
        "dual-wielder" => json!({ "one_handed_non_light_two_weapon_fighting": true, "draw_or_stow_two_one_handed_weapons": true, "armor_class_bonus_condition": "wielding_separate_one_handed_melee_weapons" }),
        "dungeon-delver" => json!({ "advantage_detect_secret_doors": true, "advantage_trap_saves": true, "advantage_trap_disarm_checks": true, "trap_damage_resistance": true, "search_normal_travel_pace": true }),
        "durable" => json!({ "hit_die_recovery_minimum": "max(2, constitution_modifier * 2)" }),
        "elemental-adept" => json!({ "ignore_resistance_to_selected_damage": true, "damage_die_one_becomes_two": true, "can_take_again_with_different_damage_type": true }),
        "grappler" => json!({ "advantage_attacks_against_grappled": true, "pin_action_restrains_both": true }),
        "great-weapon-master" => json!({ "heavy_melee_attack_penalty": -5, "heavy_melee_damage_bonus": 10, "bonus_action_attack_on_crit_or_zero": true }),
        "healer" => json!({ "healer_kit_stabilize_hp": 1, "healer_kit_action_healing": "1d6 + 4 + target_hit_dice", "healer_kit_once_per_rest_per_target": true }),
        "heavy-armor-master" => json!({ "nonmagical_bls_damage_reduction": 3 }),
        "inspiring-leader" => json!({ "inspiring_time_minutes": 10, "temporary_hp": "character_level + charisma_modifier", "temporary_hp_targets_max": 6, "temporary_hp_recovery": "short_or_long_rest" }),
        "keen-mind" => json!({ "know_north": true, "know_time_to_sunset": true, "recall_past_days": 30 }),
        "lucky" => json!({ "luck_points": 3, "luck_points_recovery": "long_rest" }),
        "mage-slayer" => json!({ "reaction_attack_spell_cast_within_feet": 5, "advantage_saves_against_nearby_spellcasters": true, "concentration_save_disadvantage_on_damage": true }),
        "martial-adept" => json!({ "superiority_dice": 1, "superiority_die": "d6", "superiority_die_recovery": "short_or_long_rest", "maneuver_save_ability": "str_or_dex" }),
        "medium-armor-master" => json!({ "medium_armor_max_dex_bonus": 3, "medium_armor_stealth_disadvantage": false }),
        "mounted-combatant" => json!({ "advantage_melee_attacks_smaller_unmounted": true, "redirect_attack_from_mount": true, "mount_dex_save_reaction": true }),
        "observant" => json!({ "read_lips_if_language_known": true }),
        "polearm-master" => json!({ "bonus_action_butt_attack": true, "butt_attack_damage": "1d4 bludgeoning", "opportunity_attack_on_reach_entry": true, "reach_weapons": ["glaive", "halberd", "quarterstaff", "spear"] }),
        "savage-attacker" => json!({ "reroll_melee_weapon_damage_once_per_turn": true }),
        "sentinel" => json!({ "opportunity_attack_sets_speed_zero": true, "disengage_does_not_avoid_opportunity": true, "reaction_attack_when_adjacent_target_attacked": true }),
        "shield-master" => json!({ "bonus_action_shove_after_attack": true, "add_shield_bonus_to_single_target_dex_save": true, "reaction_no_damage_on_successful_single_target_dex_save": true }),
        "sharpshooter" => json!({ "long_range_no_disadvantage": true, "ignore_half_and_three_quarters_cover": true, "ranged_attack_penalty": -5, "ranged_damage_bonus": 10 }),
        "skulker" => json!({ "dim_light_no_disadvantage": true, "missed_ranged_attack_reveals_no_position": true, "hide_when_lightly_obscured": true }),
        "spell-sniper" => json!({ "double_range_attack_roll_spell": true, "ignore_half_and_three_quarters_cover_spell": true }),
        "tavern-brawler" => json!({ "improvised_weapon_proficiency": true, "unarmed_strike_damage": "1d4", "grapple_bonus_action_after_unarmed_hit": true }),
        "tough" => json!({ "hit_point_maximum_bonus_per_level": 2 }),
        "war-caster" => json!({ "concentration_save_advantage": true, "somatic_components_with_hands_full": true, "opportunity_spell_instead_of_attack": true }),
        "weapon-master" => json!({ "weapon_choices": 4 }),
        _ => return None,
    };
    Some(value)
}

// Полное описание правил PHB 2014 для карточки черты. Это текст правил, а не
// отчёт о том, какие из эффектов уже подключены к боевому обработчику.
const FEAT_DESCRIPTIONS: &[(&str, &[&str])] = &[
    ("actor", &[
        "Увеличьте Харизму на 1, максимум до 20.",
        "Вы совершаете с преимуществом проверки Харизмы (Обман) и Харизмы (Выступление), когда пытаетесь выдать себя за другого человека.",
        "Вы можете копировать речь другого человека или звуки других существ. Для этого нужно не менее минуты слышать речь человека или звук существа. Слушатель распознаёт подделку успешной проверкой Мудрости (Проницательность), противопоставленной вашей проверке Харизмы (Обман).",
    ]),
    ("athlete", &[
        "Увеличьте Силу или Ловкость на 1, максимум до 20.",
        "Когда вы лежите, вставание требует только 5 футов перемещения. Подъём по вертикальной поверхности не тратит дополнительное перемещение.",
        "Для прыжка в длину или высоту с разбега вам достаточно переместиться на 5 футов вместо обычных 10.",
    ]),
    ("alert", &[
        "Вы получаете бонус +5 к инициативе.",
        "Пока вы в сознании, вас нельзя застать врасплох.",
        "Невидимые для вас атакующие не получают преимущество на броски атаки только из-за того, что вы их не видите.",
    ]),
    ("war-caster", &[
        "Вы совершаете с преимуществом спасброски Телосложения, которые делаете для сохранения концентрации на заклинании после получения урона.",
        "Вы можете выполнять соматические компоненты заклинаний даже тогда, когда держите оружие или щит в одной или обеих руках.",
        "Когда перемещение враждебного существа провоцирует от вас провоцированную атаку, вы можете реакцией вместо неё наложить на это существо заклинание. У заклинания должно быть время накладывания 1 действие, и оно должно иметь целью только это существо.",
    ]),
    ("grappler", &[
        "Вы совершаете с преимуществом броски атаки по существу, схваченному вами.",
        "Вы можете действием попытаться прижать схваченное вами существо. Совершите ещё одну проверку захвата; при успехе вы и существо получаете состояние «опутан» до окончания захвата.",
    ]),
    ("lucky", &[
        "Вы получаете 3 очка удачи. После окончания продолжительного отдыха вы восстанавливаете все потраченные очки.",
        "Когда вы совершаете бросок атаки, проверку характеристики или спасбросок, вы можете потратить очко удачи и бросить дополнительный d20. Выберите, какой из бросков использовать для определения результата; потратить очко можно после броска, но до объявления результата.",
        "Когда по вам совершают бросок атаки, вы можете потратить очко удачи, бросить d20 и выбрать, использовать ли бросок атакующего или ваш. Если несколько существ тратят очки удачи на один бросок, очки отменяют друг друга и дополнительные кости не бросаются.",
    ]),
    ("mounted-combatant", &[
        "Пока вы верхом и не недееспособны, вы совершаете с преимуществом атаки в ближнем бою по любому существу без верхового животного, которое меньше вашего верхового животного.",
        "Вы можете заставить атаку, нацеленную на ваше верховое животное, нацелиться вместо него на вас.",
        "Если ваше верховое животное подвергается эффекту, позволяющему совершить спасбросок Ловкости для получения половины урона, оно не получает урона при успехе и получает только половину урона при провале.",
    ]),
    ("observant", &[
        "Увеличьте Интеллект или Мудрость на 1, максимум до 20.",
        "Увеличьте пассивную Мудрость (Восприятие) и пассивный Интеллект (Расследование) на 5.",
        "Если вы видите рот говорящего существа и понимаете язык, на котором оно говорит, вы можете читать по его губам.",
    ]),
    ("martial-adept", &[
        "Вы изучаете два приёма из списка архетипа Воинский мастер класса воина. Если приём требует спасброска, СЛ равна 8 + ваш бонус мастерства + ваш модификатор Силы или Ловкости (на ваш выбор).",
        "Вы получаете одну кость превосходства d6 для усиления приёмов. Вы тратите её при использовании приёма и восстанавливаете после короткого или продолжительного отдыха. Если у вас уже есть кости превосходства, эта кость добавляется к ним.",
    ]),
    ("inspiring-leader", &[
        "Потратьте 10 минут, чтобы воодушевить спутников. Выберите до шести дружественных существ, включая себя, в пределах 30 футов, которые могут видеть или слышать вас и понимать вас. Каждое выбранное существо получает временные хиты в количестве, равном вашему уровню + вашему модификатору Харизмы.",
        "Существо не может снова получить временные хиты от этой черты, пока не закончит короткий или продолжительный отдых.",
    ]),
    ("savage-attacker", &[
        "Один раз в ход, когда вы бросаете урон для атаки оружием ближнего боя, вы можете перебросить кости урона оружия и использовать любую из двух сумм.",
    ]),
    ("tavern-brawler", &[
        "Увеличьте Силу или Телосложение на 1, максимум до 20.",
        "Вы получаете владение импровизированным оружием, а урон вашей безоружной атаки становится 1d4.",
        "Когда вы попадаете по существу безоружной атакой или импровизированным оружием в свой ход, вы можете бонусным действием попытаться схватить это существо.",
    ]),
    ("lightly-armored", &[
        "Увеличьте Силу или Ловкость на 1, максимум до 20.",
        "Вы получаете владение лёгкими доспехами.",
    ]),
    ("moderately-armored", &[
        "Увеличьте Силу или Ловкость на 1, максимум до 20.",
        "Вы получаете владение средними доспехами и щитами.",
    ]),
    ("heavily-armored", &[
        "Увеличьте Силу на 1, максимум до 20.",
        "Вы получаете владение тяжёлыми доспехами.",
    ]),
    ("dual-wielder", &[
        "Вы получаете бонус +1 к КД, пока держите отдельное одноручное оружие ближнего боя в каждой руке.",
        "Вы можете сражаться двумя оружиями, даже если одноручное оружие ближнего боя в одной или обеих руках не имеет свойства «лёгкое».",
        "Вы можете вытащить или убрать два одноручных оружия одновременно, когда обычно могли бы вытащить или убрать только одно.",
    ]),
    ("dungeon-delver", &[
        "Вы совершаете с преимуществом проверки Мудрости (Восприятие) и Интеллекта (Расследование), чтобы обнаружить тайные двери.",
        "Вы совершаете с преимуществом спасброски, чтобы избежать ловушек или сопротивляться им, и получаете сопротивление урону от ловушек.",
        "Вы можете искать ловушки во время путешествия обычным темпом, а не только медленным.",
    ]),
    ("durable", &[
        "Увеличьте Телосложение на 1, максимум до 20.",
        "Когда вы бросаете Кость Хитов, чтобы восстановить хиты, минимальное число восстановленных хитов равно удвоенному модификатору Телосложения, но не менее 2.",
    ]),
    ("healer", &[
        "Когда вы используете набор целителя для стабилизации умирающего существа, оно восстанавливает 1 хит вместо того, чтобы просто стать стабильным.",
        "Действием вы можете потратить одно применение набора целителя и восстановить существу 1d6 + 4 хита, а также дополнительные хиты в количестве, равном максимальному числу его Костей Хитов. Существо не может снова получить лечение от этой черты до окончания короткого или продолжительного отдыха.",
    ]),
    ("great-weapon-master", &[
        "В свой ход, когда вы совершаете критическое попадание оружием ближнего боя или уменьшаете хиты существа до 0 атакой оружием ближнего боя, вы можете бонусным действием совершить одну атаку оружием ближнего боя.",
        "Перед броском атаки оружием ближнего боя со свойством «тяжёлое», которым вы владеете, вы можете получить штраф −5 к броску атаки. Если атака попадает, к её урону добавляется +10.",
    ]),
    ("polearm-master", &[
        "Когда вы совершаете действие Атака и атакуете только глефой, алебардой, боевым посохом или копьём, вы можете бонусным действием совершить этим оружием ещё одну атаку противоположным концом, используя тот же модификатор характеристики, что и для основной атаки. Кость урона этой атаки — d4, а тип урона — дробящий.",
        "Когда вы держите глефу, алебарду, пику, боевой посох или копьё, другие существа провоцируют от вас провоцированную атаку, когда входят в досягаемость, которую даёт вам это оружие.",
    ]),
    ("weapon-master", &[
        "Увеличьте Силу или Ловкость на 1, максимум до 20.",
        "Выберите четыре простых или воинских оружия. Вы получаете владение каждым выбранным оружием.",
    ]),
    ("medium-armor-master", &[
        "Когда вы носите средний доспех, он не накладывает помеху на проверки Ловкости (Скрытность).",
        "Когда вы носите средний доспех, вы можете добавить к КД до 3 вместо обычных 2 от модификатора Ловкости, если ваша Ловкость равна 16 или выше.",
    ]),
    ("heavy-armor-master", &[
        "Увеличьте Силу на 1, максимум до 20.",
        "Когда вы носите тяжёлый доспех, дробящий, колющий и рубящий урон от немагического оружия уменьшается на 3.",
    ]),
    ("shield-master", &[
        "Пока вы держите щит, вы получаете следующие преимущества.",
        "Если в свой ход вы совершаете действие Атака, вы можете бонусным действием попытаться толкнуть щитом существо в пределах 5 футов от вас.",
        "Если вы не недееспособны, вы можете добавлять бонус к КД от щита к спасброскам Ловкости против заклинаний и других вредных эффектов, нацеленных только на вас.",
        "Если вы подвергаетесь эффекту, позволяющему совершить спасбросок Ловкости для получения половины урона, вы можете реакцией выставить щит между собой и источником эффекта и не получить урон при успешном спасброске.",
    ]),
    ("spell-sniper", &[
        "Когда вы накладываете заклинание, требующее броска атаки, его дальность удваивается.",
        "Ваши дальнобойные атаки заклинаниями игнорируют половину и три четверти укрытия.",
        "Вы изучаете один заговор, требующий броска атаки. Заговор выбирается из списка заклинаний барда, жреца, друида, чародея, колдуна или волшебника. Базовая характеристика для этого заговора зависит от выбранного списка: Харизма для барда, чародея и колдуна; Интеллект для волшебника; Мудрость для друида и жреца.",
    ]),
    ("sharpshooter", &[
        "Атаки дальнобойным оружием на дальней дистанции не получают помеху.",
        "Ваши дальнобойные атаки оружием игнорируют половину и три четверти укрытия.",
        "Перед броском атаки дальнобойным оружием, которым вы владеете, вы можете получить штраф −5 к броску атаки. Если атака попадает, к её урону добавляется +10.",
    ]),
    ("charger", &[
        "Когда вы используете действие Рывок, вы можете бонусным действием совершить одну атаку оружием ближнего боя или попытаться толкнуть существо.",
        "Если перед этим бонусным действием вы переместились как минимум на 10 футов по прямой, попавшая атака оружием ближнего боя получает +5 к урону либо успешный толчок отбрасывает цель на 10 футов от вас.",
    ]),
    ("defensive-duelist", &[
        "Когда вы держите оружие со свойством «фехтовальное», которым владеете, и другое существо попадает по вам атакой ближнего боя, вы можете реакцией добавить бонус мастерства к КД для этой атаки, из-за чего она может промахнуться.",
    ]),
    ("skilled", &[
        "Вы получаете владение любыми тремя навыками или инструментами в любой комбинации.",
    ]),
    ("keen-mind", &[
        "Увеличьте Интеллект на 1, максимум до 20.",
        "Вы всегда знаете, где находится север, сколько часов осталось до следующего восхода или заката, а также можете безошибочно вспомнить всё, что видели или слышали за последний месяц.",
    ]),
    ("mobile", &[
        "Ваша скорость увеличивается на 10 футов.",
        "Когда вы совершаете Рывок, труднопроходимая местность не требует от вас дополнительного перемещения в этот ход.",
        "Когда вы совершаете рукопашную атаку по существу, вы не провоцируете от него провоцированные атаки до конца хода, независимо от того, попали вы или промахнулись.",
    ]),
    ("magic-initiate", &[
        "Выберите барда, жреца, друида, чародея, колдуна или волшебника. Вы изучаете два заговора из списка заклинаний выбранного класса.",
        "Из того же списка вы изучаете одно заклинание 1-го уровня. С помощью этой черты вы можете один раз наложить его на минимальном уровне без расхода ячейки; возможность восстанавливается после продолжительного отдыха. Если выбранный для черты класс является одним из ваших классов, обычные правила его накладывания заклинаний определяют, можете ли вы расходовать его ячейки на это изученное заклинание; сама черта ячеек не создаёт.",
        "Способность для этих заклинаний определяется выбранным классом: Харизма для барда, чародея и колдуна; Мудрость для жреца и друида; Интеллект для волшебника.",
    ]),
    ("skulker", &[
        "Вы можете попытаться спрятаться, когда слегка заслонены от существа, от которого скрываетесь, например в тусклом свете, тумане или листве.",
        "Если вы скрыты от существа, промах при атаке дальнобойным оружием не раскрывает ему ваше местоположение.",
        "Тусклый свет не накладывает помеху на ваши проверки Мудрости (Восприятие), основанные на зрении.",
    ]),
    ("ritual-caster", &[
        "Требуется Интеллект или Мудрость 13 или выше. Выберите барда, жреца, друида, чародея, колдуна или волшебника; выбранный класс определяет базовую характеристику: Харизма для барда, чародея и колдуна; Интеллект для волшебника; Мудрость для друида и жреца.",
        "Вы получаете книгу ритуалов с двумя ритуальными заклинаниями 1-го уровня по вашему выбору из списка выбранного класса. Книгу нужно держать в руке во время накладывания записанных в ней заклинаний; эта черта позволяет накладывать их как ритуалы.",
        "Если вы находите письменную копию заклинания, оно должно быть в списке выбранного класса, иметь ключевое слово «ритуал» и быть не выше половины вашего уровня, округлённой вверх. Вы можете переписать его в книгу: это занимает 2 часа за каждый уровень заклинания и стоит 50 зм за каждый уровень заклинания. В книгу можно добавлять новые подходящие ритуалы во время приключений.",
    ]),
    ("elemental-adept", &[
        "Выберите один тип урона: кислота, холод, огонь, электричество или гром. Заклинания, которые вы накладываете и которые причиняют выбранный тип урона, игнорируют сопротивление этому типу.",
        "При определении урона заклинания выбранной стихии вы можете считать выпавшие на костях единицы двойками.",
        "Эту черту можно выбрать несколько раз, но каждый раз нужно выбрать другой тип урона.",
    ]),
    ("resilient", &[
        "Увеличьте одну выбранную характеристику на 1, максимум до 20.",
        "Вы получаете владение спасбросками выбранной характеристикой.",
    ]),
    ("sentinel", &[
        "Когда вы попадаете по существу провоцированной атакой, его скорость становится 0 до конца текущего хода, и оно не может продолжить перемещение.",
        "Существа провоцируют от вас провоцированные атаки, даже если передвижение использовало действие Отступление.",
        "Когда существо в пределах 5 футов от вас совершает атаку по цели, отличной от вас и не имеющей этой черты, вы можете реакцией совершить по атакующему одну атаку оружием ближнего боя.",
    ]),
    ("mage-slayer", &[
        "Когда существо в пределах 5 футов от вас накладывает заклинание, вы можете реакцией совершить по нему одну атаку оружием ближнего боя.",
        "Если вы наносите урон существу, концентрирующемуся на заклинании, оно совершает с помехой спасбросок Телосложения для сохранения концентрации.",
        "Вы совершаете с преимуществом спасброски против заклинаний, наложенных существами в пределах 5 футов от вас.",
    ]),
    ("tough", &[
        "Когда вы получаете эту черту, ваш максимум хитов увеличивается на 2 за каждый уже полученный уровень.",
        "Каждый раз после этого, когда вы получаете новый уровень, ваш максимум хитов дополнительно увеличивается ещё на 2.",
    ]),
    ("crossbow-expert", &[
        "Вы игнорируете свойство «перезарядка» у арбалетов, которыми владеете.",
        "Нахождение в пределах 5 футов от враждебного существа не накладывает помеху на ваши дальнобойные броски атаки.",
        "Когда вы совершаете действие Атака и атакуете одноручным оружием, вы можете бонусным действием атаковать из ручного арбалета, который держите в руке.",
    ]),
    ("linguist", &[
        "Увеличьте Интеллект на 1, максимум до 20, и выучите три языка по вашему выбору.",
        "Вы можете создавать письменные шифры. Другие существа не могут расшифровать созданный вами код, если вы их не обучили, они не преуспели в проверке Интеллекта со СЛ, равной вашему Интеллекту + ваш бонус мастерства, или не использовали магию для расшифровки.",
    ]),
];

fn ability_schema(options: &[&str]) -> Value {
    json!({ "ability": { "type": "ability", "options": options } })
}

fn spellcasting_class_schema() -> Value {
    json!({ "type": "spellcasting_class", "options": SPELLCASTING_CLASSES })
}

/// Строка `FEAT_DEFINITIONS`: id, название, английское название, кратко и
/// схема выбора (требования — из `PREREQUISITES` по id).
fn feat_definitions() -> Vec<(&'static str, &'static str, &'static str, &'static str, Option<Value>)> {
    vec![
        ("actor", "Артистичный", "Actor", "Мастер перевоплощений и убедительной имитации.", None),
        ("athlete", "Атлетичный", "Athlete", "Физическая подготовка ускоряет подъём и прыжки.", Some(ability_schema(&["str", "dex"]))),
        ("alert", "Бдительный", "Alert", "Вы быстро замечаете угрозу и почти не даёте застать себя врасплох.", None),
        ("war-caster", "Боевой заклинатель", "War Caster", "Вы сохраняете концентрацию и колдуете, удерживая оружие или щит.", None),
        ("grappler", "Борец", "Grappler", "Захваты и удержание противника становятся надёжнее.", None),
        ("lucky", "Везунчик", "Lucky", "Трижды за день удача помогает изменить результат броска.", None),
        ("mounted-combatant", "Верховой боец", "Mounted Combatant", "Вы защищаете ездовое животное и лучше сражаетесь верхом.", None),
        ("observant", "Внимательный", "Observant", "Вы замечаете детали, читаете по губам и запоминаете больше.", Some(ability_schema(&["int", "wis"]))),
        ("martial-adept", "Воинский адепт", "Martial Adept", "Два боевых приёма и кость превосходства расширяют тактику.", Some(json!({ "maneuvers": { "type": "maneuver", "count": 2, "options": PHB_MARTIAL_ADEPT_MANEUVER_IDS } }))),
        ("inspiring-leader", "Воодушевляющий лидер", "Inspiring Leader", "Речь перед боем даёт союзникам запас временных хитов.", None),
        ("savage-attacker", "Дикий атакующий", "Savage Attacker", "Раз за ход вы выбираете лучший бросок урона оружием ближнего боя.", None),
        ("tavern-brawler", "Драчун", "Tavern Brawler", "Подручные предметы и кулаки становятся полноценным оружием.", Some(ability_schema(&["str", "con"]))),
        ("lightly-armored", "Знаток лёгких доспехов", "Lightly Armored", "Тренировка позволяет носить лёгкие доспехи.", Some(ability_schema(&["str", "dex"]))),
        ("moderately-armored", "Знаток средних доспехов", "Moderately Armored", "Вы осваиваете средние доспехи и щиты.", Some(ability_schema(&["str", "dex"]))),
        ("heavily-armored", "Знаток тяжёлых доспехов", "Heavily Armored", "Вы осваиваете тяжёлые доспехи.", None),
        ("dual-wielder", "Использование двух оружий", "Dual Wielder", "Вы сражаетесь двумя одноручными оружиями, даже если они не лёгкие.", None),
        ("dungeon-delver", "Исследователь подземелий", "Dungeon Delver", "Ловушки и тайные двери редко остаются для вас незамеченными.", None),
        ("durable", "Стойкий", "Durable", "Отдых и Кости Хитов восстанавливают больше здоровья.", None),
        ("healer", "Лекарь", "Healer", "Аптечка в ваших руках лечит и возвращает союзников в строй.", None),
        ("great-weapon-master", "Мастер большого оружия", "Great Weapon Master", "Тяжёлое оружие позволяет обменивать точность на урон и добивать врагов.", None),
        ("polearm-master", "Мастер древкового оружия", "Polearm Master", "Древковое оружие даёт дополнительный удар и контролирует подход.", None),
        ("weapon-master", "Мастер оружия", "Weapon Master", "Четыре выбранных оружия становятся вам знакомы.", Some(json!({ "weapons": { "type": "weapon", "count": 4 } }))),
        ("medium-armor-master", "Мастер средних доспехов", "Medium Armor Master", "Средние доспехи перестают мешать скрытности и лучше используют Ловкость.", None),
        ("heavy-armor-master", "Мастер тяжёлых доспехов", "Heavy Armor Master", "Тяжёлые доспехи снижают обычный физический урон.", None),
        ("shield-master", "Мастер щитов", "Shield Master", "Щит помогает сбивать врагов и переживать направленные эффекты.", None),
        ("spell-sniper", "Меткие заклинания", "Spell Sniper", "Дальнобойные заклинания точнее обходят укрытия.", Some(json!({ "class": spellcasting_class_schema(), "cantrip": { "type": "attack_roll_cantrip", "count": 1 } }))),
        ("sharpshooter", "Меткий стрелок", "Sharpshooter", "Дальний выстрел сохраняет силу и точность сквозь укрытие.", None),
        ("charger", "Налётчик", "Charger", "Разгон превращается в мощную атаку или толчок.", None),
        ("defensive-duelist", "Оборонительный дуэлянт", "Defensive Duelist", "Фехтовальная реакция может превратить попадание в промах.", None),
        ("skilled", "Одарённый", "Skilled", "Три дополнительных владения расширяют набор умений.", Some(json!({ "skills": { "type": "skill_or_tool", "count": 3 }, "tools": { "type": "skill_or_tool", "count": 3 } }))),
        ("keen-mind", "Отличная память", "Keen Mind", "Вы безошибочно ориентируетесь во времени, направлении и деталях.", None),
        ("mobile", "Подвижный", "Mobile", "Вы быстрее перемещаетесь и легче выходите из ближнего боя.", None),
        ("magic-initiate", "Посвящённый в магию", "Magic Initiate", "Два заговора и одно заклинание дают начальное обучение магии.", Some(json!({ "class": spellcasting_class_schema(), "cantrips": { "type": "cantrip", "count": 2 }, "spell": { "type": "first_level_spell", "count": 1 } }))),
        ("skulker", "Проныра", "Skulker", "Тусклый свет и промахи меньше выдают скрывающегося стрелка.", None),
        ("ritual-caster", "Ритуальный заклинатель", "Ritual Caster", "Книга ритуалов сохраняет два первых ритуала выбранной традиции.", Some(json!({ "class": spellcasting_class_schema(), "rituals": { "type": "first_level_ritual", "count": 2 } }))),
        ("elemental-adept", "Стихийный адепт", "Elemental Adept", "Вы выбираете стихию и лучше пробиваете её сопротивление.", Some(json!({ "damage_type": { "type": "damage_type", "options": ELEMENTAL_DAMAGE_TYPES } }))),
        ("resilient", "Устойчивый", "Resilient", "Одна характеристика растёт, а её спасбросок становится привычным.", Some(ability_schema(&ABILITY_IDS))),
        ("sentinel", "Страж", "Sentinel", "Вы удерживаете врагов рядом и наказываете за атаки по союзникам.", None),
        ("mage-slayer", "Убийца магов", "Mage Slayer", "Ближний бой мешает противнику колдовать и держать концентрацию.", None),
        ("tough", "Крепкий", "Tough", "Каждый уровень даёт ещё два максимальных хита.", None),
        ("crossbow-expert", "Эксперт в арбалетах", "Crossbow Expert", "Арбалет можно использовать вплотную и быстро перезаряжать.", None),
        ("linguist", "Языковед", "Linguist", "Три языка и собственные шифры расширяют общение.", Some(json!({ "languages": { "type": "language", "count": 3 } }))),
    ]
}

fn fixed_ability_increases(id: &str) -> &'static [(&'static str, i64)] {
    match id {
        "actor" => &[("cha", 1)],
        "durable" => &[("con", 1)],
        "heavily-armored" | "heavy-armor-master" => &[("str", 1)],
        "keen-mind" | "linguist" => &[("int", 1)],
        _ => &[],
    }
}

fn armor_benefits(id: &str) -> &'static [&'static str] {
    match id {
        "lightly-armored" => &["light"],
        "moderately-armored" => &["medium", "shield"],
        "heavily-armored" => &["heavy"],
        _ => &[],
    }
}

/// `PHB_2014_FEATS`: сорок две черты PHB 2014.
pub static PHB_2014_FEATS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    let source = &*PHB_2014_FEATS_SOURCE;
    feat_definitions()
        .into_iter()
        .map(|(id, name, english_name, summary, choice_schema)| {
            let description = lookup(FEAT_DESCRIPTIONS, id).map_or_else(|| json!([summary]), |paragraphs| json!(paragraphs));
            json!({
                "id": id, "name": name, "english_name": english_name, "summary": summary, "source": source["source"],
                "source_url": source["source_url"], "book": source["book"],
                "edition": source["edition"], "prerequisites": prerequisites(id),
                "choice_schema": choice_schema.unwrap_or_else(|| json!({})), "description": description,
                "mechanics_status": "partial",
            })
        })
        .collect()
});

fn feat_by_id(id: &str) -> Option<&'static Value> {
    PHB_2014_FEATS.iter().find(|feat| feat.get("id").and_then(Value::as_str) == Some(id))
}

/// `isClassSpellAvailable(spell, classKey, actor)`: общая для клиента и
/// сервера проверка доступности классового заклинания. Для героев PHB
/// заговоры и первый круг ограничены списками редакции 2014; расширенные
/// списки и высшие круги остаются доступны.
pub fn is_class_spell_available(spell: Option<&Value>, class_key: &str, actor: Option<&Value>) -> bool {
    let id = js::s(defined(prop(spell, "id")));
    let classes = array(prop(spell, "classes"));
    let benefits = prop(actor, "creationBenefits");
    if !js::truthy(benefits) {
        return includes_str(classes, class_key);
    }
    if includes_str(array(prop(benefits, "expanded_spells")), &id) {
        return true;
    }
    let level = js::number(prop(spell, "level"));
    if level == 0.0 {
        return class_spell_list(&PHB_CANTRIPS, class_key).is_some_and(|list| list.contains(&id.as_str()));
    }
    if level == 1.0 {
        return class_spell_list(&PHB_FIRST_LEVEL_SPELLS, class_key).is_some_and(|list| list.contains(&id.as_str()));
    }
    includes_str(classes, class_key)
}

/// Нормализованный контекст героя (`normalizeContext`).
struct FeatContext {
    abilities: Vec<(&'static str, f64)>,
    weapons: Vec<String>,
    armor: Vec<String>,
    languages: Vec<String>,
    existing_feats: Vec<String>,
    existing_feat_choices: Value,
    can_cast_spells: bool,
    allow_capped_ability_increase: bool,
}

impl FeatContext {
    /// `abilityScore(context, ability)`: значение или 10.
    fn ability_score(&self, ability: &str) -> f64 {
        lookup(&self.abilities, ability).unwrap_or(10.0)
    }
}

fn normalize_abilities(value: Option<&Value>) -> Result<Vec<(&'static str, f64)>, Refusal> {
    let Some(value) = defined(value) else {
        return Ok(Vec::new());
    };
    if !value.is_object() {
        return Err(("INVALID_CONTEXT", "context.abilities должен быть объектом".into()));
    }
    let mut result = Vec::new();
    for ability in ABILITY_IDS {
        if !has_own(Some(value), ability) {
            continue;
        }
        let score = js::number(value.get(ability));
        if !score.is_finite() {
            return Err(("INVALID_CONTEXT", format!("context.abilities.{ability} должен быть числом")));
        }
        result.push((ability, score));
    }
    Ok(result)
}

/// `firstList(record, names)`: список из первого собственного поля
/// (не массив — пусто, без перехода к следующему имени).
fn first_list<'a>(record: Option<&'a Value>, names: &[&str]) -> &'a [Value] {
    names.iter().find(|name| has_own(record, name)).map_or(&[], |name| array(prop(record, name)))
}

fn unique_tokens(values: impl IntoIterator<Item = String>) -> Vec<String> {
    crate::support::unique_strings(values)
}

fn normalize_context(context: Option<&Value>) -> Result<FeatContext, Refusal> {
    let empty = Value::Object(Map::new());
    let context = defined(context).unwrap_or(&empty);
    if !context.is_object() {
        return Err(("INVALID_CONTEXT", "context должен быть объектом".into()));
    }
    let context = Some(context);
    let abilities = normalize_abilities(prop(context, "abilities"))?;
    let proficiency = [prop(context, "proficiency"), prop(context, "proficiencies")].into_iter().find(|value| matches!(value, Some(Value::Object(_)))).flatten();
    let weapon_values = first_list(proficiency, &["weapons", "weapon", "weapon_proficiencies", "weaponProficiencies"]);
    let armor_values = first_list(proficiency, &["armor", "armors", "armor_proficiencies", "armorProficiencies"]);
    let weapons = unique_tokens(
        weapon_values
            .iter()
            .chain(first_list(context, &["weapons", "weaponProficiencies", "weapon_proficiencies"]))
            .map(|value| canonical_token(Some(value))),
    );
    let armor = unique_tokens(armor_values.iter().chain(first_list(context, &["armor", "armorProficiencies", "armor_proficiencies"])).map(|value| {
        let token = canonical_token(Some(value));
        let normalized = token.strip_suffix("_armor").unwrap_or(&token).to_string();
        if normalized == "shields" {
            "shield".to_string()
        } else {
            normalized
        }
    }));
    // `skills`, `tools` и `proficiencyBonus` JS тоже собирает, но ни одна
    // проверка их не читает.
    let languages = unique_tokens(
        first_list(context, &["languages", "languageProficiencies", "language_proficiencies"]).iter().map(|value| canonical_token(Some(value))),
    );
    let existing_feats = unique_tokens(first_list(context, &["feats", "selectedFeats", "selected_feats"]).iter().map(|value| token(Some(value))));
    let existing_feat_choices = ["existingFeatChoices", "existing_feat_choices", "featChoices", "feat_choices"]
        .iter()
        .find_map(|key| defined(prop(context, key)))
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    Ok(FeatContext {
        abilities,
        weapons,
        armor,
        languages,
        existing_feats,
        existing_feat_choices,
        can_cast_spells: js::is_true(prop(context, "canCastSpells")) || js::is_true(prop(context, "can_cast_spells")),
        allow_capped_ability_increase: js::is_true(prop(context, "allowCappedAbilityIncrease"))
            || js::is_true(prop(context, "allow_capped_ability_increase")),
    })
}

/// `prerequisiteResult(feat, context)`: невыполненные требования черты.
fn prerequisite_result(feat: &Value, context: &FeatContext) -> Vec<String> {
    let mut unmet = Vec::new();
    for prerequisite in array(feat.get("prerequisites")) {
        let kind = prerequisite.get("kind").and_then(Value::as_str);
        let label = || js::s(prerequisite.get("label"));
        let minimum = js::number(prerequisite.get("minimum"));
        let score = |ability: &Value| context.ability_score(&js::s(Some(ability)));
        if kind == Some("ability") && prerequisite.get("ability").is_some_and(|ability| score(ability) < minimum) {
            unmet.push(label());
        }
        if kind == Some("ability_any") && !array(prerequisite.get("abilities")).iter().any(|ability| score(ability) >= minimum) {
            unmet.push(label());
        }
        if kind == Some("spellcasting") && !context.can_cast_spells {
            unmet.push(label());
        }
        let value = js::s(prerequisite.get("value"));
        let category = prerequisite.get("category").and_then(Value::as_str);
        if kind == Some("proficiency") && category == Some("armor") && !context.armor.contains(&value) {
            unmet.push(label());
        }
        if kind == Some("proficiency") && category == Some("weapon") && !context.weapons.contains(&value) {
            unmet.push(label());
        }
    }
    unmet
}

fn empty_benefits() -> Map<String, Value> {
    let value = json!({
        "ability_increases": {}, "saving_throw_proficiencies": [], "skill_proficiencies": [], "tool_proficiencies": [],
        "language_proficiencies": [], "weapon_proficiencies": [], "armor_proficiencies": [], "speed_bonus": 0,
        "hit_point_maximum_bonus_per_level": 0, "armor_class_bonus": 0, "initiative_bonus": 0,
        "passive_skill_bonuses": {}, "spellcasting": null, "static": {},
    });
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn benefit_list<'a>(benefits: &'a mut Map<String, Value>, key: &str) -> &'a mut Vec<Value> {
    let slot = benefits.entry(key.to_string()).or_insert_with(|| json!([]));
    if !slot.is_array() {
        *slot = json!([]);
    }
    match slot {
        Value::Array(items) => items,
        _ => unreachable!("поле только что стало массивом"),
    }
}

fn benefit_object<'a>(benefits: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let slot = benefits.entry(key.to_string()).or_insert_with(|| json!({}));
    if !slot.is_object() {
        *slot = json!({});
    }
    match slot {
        Value::Object(map) => map,
        _ => unreachable!("поле только что стало объектом"),
    }
}

fn push_strings(benefits: &mut Map<String, Value>, key: &str, values: &[String]) {
    benefit_list(benefits, key).extend(values.iter().map(|value| json!(value)));
}

fn add_ability_increase(benefits: &mut Map<String, Value>, ability: &str, context: &FeatContext) -> Result<(), Refusal> {
    if !ABILITY_IDS.contains(&ability) {
        return Err(("CHOICE_INVALID", "Неизвестная характеристика".into()));
    }
    if context.ability_score(ability) >= 20.0 {
        if context.allow_capped_ability_increase {
            return Ok(());
        }
        return Err(("ABILITY_MAX_REACHED", "Значение характеристики уже достигло максимума 20".into()));
    }
    let increases = benefit_object(benefits, "ability_increases");
    let current = defined(increases.get(ability)).map_or(0.0, |value| js::number(Some(value)));
    increases.insert(ability.to_string(), js::num(current + 1.0));
    Ok(())
}

type Resolved = Result<Map<String, Value>, Refusal>;

fn choices_of(entries: Vec<(&str, Value)>) -> Map<String, Value> {
    entries.into_iter().map(|(key, value)| (key.to_string(), value)).collect()
}

fn resolve_ability_choice(id: &str, choices: &Map<String, Value>, context: &FeatContext, benefits: &mut Map<String, Value>) -> Resolved {
    let Some(allowed) = ability_choices(id) else {
        return Ok(Map::new());
    };
    let selected = canonical_token(choice_value(choices, &["ability", "ability_id", "abilityId"]));
    if selected.is_empty() {
        return Err(("CHOICE_REQUIRED", "Нужно выбрать характеристику".into()));
    }
    if !allowed.contains(&selected.as_str()) {
        return Err(("CHOICE_INVALID", "Эта характеристика недоступна для выбранной черты".into()));
    }
    add_ability_increase(benefits, &selected, context)?;
    Ok(choices_of(vec![("ability", json!(selected))]))
}

fn resolve_fixed_ability(id: &str, context: &FeatContext, benefits: &mut Map<String, Value>) -> Result<(), Refusal> {
    for (ability, amount) in fixed_ability_increases(id) {
        if context.ability_score(ability) >= 20.0 {
            if context.allow_capped_ability_increase {
                continue;
            }
            return Err(("ABILITY_MAX_REACHED", "Значение характеристики уже достигло максимума 20".into()));
        }
        benefit_object(benefits, "ability_increases").insert(ability.to_string(), json!(amount));
    }
    Ok(())
}

fn resolve_skilled(choices: &Map<String, Value>, benefits: &mut Map<String, Value>) -> Resolved {
    let skills = choice_value(choices, &["skills", "skill_ids", "skillIds"]);
    let tools = choice_value(choices, &["tools", "tool_ids", "toolIds"]);
    if skills.is_none() && tools.is_none() {
        return Err(("CHOICE_REQUIRED", "Нужно выбрать три навыка или инструмента".into()));
    }
    let selected_skills: Vec<String> = array(skills).iter().map(|value| canonical_token(Some(value))).collect();
    let selected_tools: Vec<String> = array(tools).iter().map(|value| canonical_token(Some(value))).collect();
    if selected_skills.iter().any(|id| !SKILLS.contains(&id.as_str())) {
        return Err(("CHOICE_INVALID", "Одарённый: неизвестный навык".into()));
    }
    if selected_tools.iter().any(|id| !TOOLS.contains(&id.as_str())) {
        return Err(("CHOICE_INVALID", "Одарённый: неизвестный инструмент".into()));
    }
    if selected_skills.len() + selected_tools.len() != 3 {
        return Err(("CHOICE_COUNT_INVALID", "Одарённый: нужно выбрать ровно три навыка или инструмента".into()));
    }
    if unique_tokens(selected_skills.iter().chain(&selected_tools).cloned()).len() != 3 {
        return Err(("CHOICE_DUPLICATE", "Одарённый: варианты не должны повторяться".into()));
    }
    push_strings(benefits, "skill_proficiencies", &selected_skills);
    push_strings(benefits, "tool_proficiencies", &selected_tools);
    Ok(choices_of(vec![("skills", json!(selected_skills)), ("tools", json!(selected_tools))]))
}

fn resolve_weapon_master(choices: &Map<String, Value>, benefits: &mut Map<String, Value>) -> Resolved {
    let selected = exact_list(choice_value(choices, &["weapons", "weapon_ids", "weaponIds"]), 4, "Мастер оружия", canonical_token)?;
    if selected.iter().any(|id| !WEAPONS.contains(&id.as_str())) {
        return Err(("CHOICE_INVALID", "Мастер оружия: неизвестное оружие".into()));
    }
    push_strings(benefits, "weapon_proficiencies", &selected);
    Ok(choices_of(vec![("weapons", json!(selected))]))
}

fn resolve_martial_adept(choices: &Map<String, Value>, benefits: &mut Map<String, Value>) -> Resolved {
    let selected = exact_list(choice_value(choices, &["maneuvers", "maneuver_ids", "maneuverIds"]), 2, "Воинский адепт: приёмы", maneuver_token)?;
    if selected.iter().any(|id| !PHB_MARTIAL_ADEPT_MANEUVER_IDS.contains(&id.as_str())) {
        return Err(("CHOICE_INVALID", "Воинский адепт: неизвестный боевой приём".into()));
    }
    benefit_object(benefits, "static").insert("maneuvers".into(), json!(selected));
    Ok(choices_of(vec![("maneuvers", json!(selected))]))
}

fn resolve_languages(choices: &Map<String, Value>, context: &FeatContext, benefits: &mut Map<String, Value>) -> Resolved {
    let selected = exact_list(choice_value(choices, &["languages", "language_ids", "languageIds"]), 3, "Языковед", canonical_token)?;
    if selected.iter().any(|id| !LANGUAGES.contains(&id.as_str())) {
        return Err(("CHOICE_INVALID", "Языковед: неизвестный язык".into()));
    }
    if selected.iter().any(|id| context.languages.contains(id)) {
        return Err(("CHOICE_DUPLICATE", "Языковед: персонаж уже знает выбранный язык".into()));
    }
    push_strings(benefits, "language_proficiencies", &selected);
    Ok(choices_of(vec![("languages", json!(selected))]))
}

fn spellcasting_class(choices: &Map<String, Value>, refusal: &str) -> Result<&'static str, Refusal> {
    let class_key = canonical_token(choice_value(choices, &["class", "class_key", "classKey"]));
    SPELLCASTING_CLASSES.iter().copied().find(|candidate| *candidate == class_key).ok_or_else(|| ("CHOICE_INVALID", refusal.to_string()))
}

fn resolve_magic_initiate(choices: &Map<String, Value>, benefits: &mut Map<String, Value>) -> Resolved {
    let class_key = spellcasting_class(choices, "Посвящённый в магию: нужно выбрать класс заклинателя")?;
    let cantrips = exact_list(choice_value(choices, &["cantrips", "cantrip_ids", "cantripIds"]), 2, "Посвящённый в магию: заговоры", canonical_spell_id)?;
    let list = class_spell_list(&PHB_CANTRIPS, class_key).unwrap_or(&[]);
    if cantrips.iter().any(|id| !list.contains(&id.as_str())) {
        return Err(("SPELL_CHOICE_INVALID", "Заговор недоступен в списке выбранного класса".into()));
    }
    let spell = canonical_spell_id(choice_value(choices, &["spell", "spell_id", "spellId"]));
    if spell.is_empty() {
        return Err(("CHOICE_REQUIRED", "Посвящённый в магию: нужно выбрать заклинание 1-го уровня".into()));
    }
    if !class_spell_list(&PHB_FIRST_LEVEL_SPELLS, class_key).unwrap_or(&[]).contains(&spell.as_str()) {
        return Err(("SPELL_CHOICE_INVALID", "Заклинание недоступно в списке выбранного класса".into()));
    }
    benefits.insert(
        "spellcasting".into(),
        json!({
            "source": "magic-initiate", "class_key": class_key, "ability": lookup(SPELLCASTING_ABILITY, class_key),
            "cantrips": cantrips, "first_level_spell": spell, "once_per_long_rest": true, "uses_spell_slots": true,
        }),
    );
    Ok(choices_of(vec![("class", json!(class_key)), ("cantrips", json!(cantrips)), ("spell", json!(spell))]))
}

fn resolve_ritual_caster(choices: &Map<String, Value>, benefits: &mut Map<String, Value>) -> Resolved {
    let class_key = spellcasting_class(choices, "Ритуальный заклинатель: нужно выбрать класс заклинателя")?;
    let rituals = exact_list(choice_value(choices, &["rituals", "ritual_ids", "ritualIds"]), 2, "Ритуальный заклинатель: ритуалы", canonical_spell_id)?;
    let list = class_spell_list(&PHB_RITUALS, class_key).unwrap_or(&[]);
    if rituals.iter().any(|id| !list.contains(&id.as_str())) {
        return Err(("SPELL_CHOICE_INVALID", "Ритуал недоступен в списке выбранного класса".into()));
    }
    benefits.insert(
        "spellcasting".into(),
        json!({
            "source": "ritual-caster", "class_key": class_key, "ability": lookup(SPELLCASTING_ABILITY, class_key), "rituals": rituals,
            "ritual_book": true, "cast_as_ritual_only": true, "can_add_rituals_found": true,
        }),
    );
    Ok(choices_of(vec![("class", json!(class_key)), ("rituals", json!(rituals))]))
}

fn resolve_spell_sniper(choices: &Map<String, Value>, benefits: &mut Map<String, Value>) -> Resolved {
    let class_key = spellcasting_class(choices, "Меткие заклинания: нужно выбрать класс заклинателя")?;
    let cantrip = canonical_spell_id(choice_value(choices, &["cantrip", "cantrip_id", "cantripId"]));
    if cantrip.is_empty() || !class_spell_list(&SPELL_SNIPER_CANTRIPS, class_key).unwrap_or(&[]).contains(&cantrip.as_str()) {
        return Err(("SPELL_CHOICE_INVALID", "Нужно выбрать заговор с броском атаки из списка класса".into()));
    }
    benefits.insert(
        "spellcasting".into(),
        json!({ "source": "spell-sniper", "class_key": class_key, "ability": lookup(SPELLCASTING_ABILITY, class_key), "cantrips": [cantrip] }),
    );
    Ok(choices_of(vec![("class", json!(class_key)), ("cantrip", json!(cantrip))]))
}

fn resolve_elemental_adept(choices: &Map<String, Value>, benefits: &mut Map<String, Value>) -> Resolved {
    let damage_type = canonical_token(choice_value(choices, &["damage_type", "damageType", "damage"]));
    if !ELEMENTAL_DAMAGE_TYPES.contains(&damage_type.as_str()) {
        return Err(("CHOICE_INVALID", "Стихийный адепт: выберите кислоту, холод, огонь, электричество или гром".into()));
    }
    benefit_object(benefits, "static").insert("selected_damage_type".into(), json!(damage_type));
    Ok(choices_of(vec![("damage_type", json!(damage_type))]))
}

/// `previousElementalDamageTypes(context)`: стихии прежних выборов черты.
fn previous_elemental_damage_types(context: &FeatContext) -> Vec<String> {
    let source = &context.existing_feat_choices;
    if !source.is_object() {
        return Vec::new();
    }
    let entries = ["elemental-adept", "elemental_adept", "elementalAdept"].iter().find_map(|key| defined(source.get(*key)));
    let list: Vec<&Value> = match entries {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(entry) => vec![entry],
        None => Vec::new(),
    };
    list.into_iter()
        .map(|entry| {
            if entry.is_object() {
                canonical_token(["damage_type", "damageType", "damage"].iter().find_map(|key| defined(entry.get(*key))))
            } else {
                canonical_token(Some(entry))
            }
        })
        .collect()
}

fn choice_keys(id: &str) -> &'static [&'static str] {
    const ABILITY: &[&str] = &["ability", "ability_id", "abilityId"];
    match id {
        "athlete" | "observant" | "tavern-brawler" | "lightly-armored" | "moderately-armored" | "resilient" => ABILITY,
        "martial-adept" => &["maneuvers", "maneuver_ids", "maneuverIds"],
        "weapon-master" => &["weapons", "weapon_ids", "weaponIds"],
        "spell-sniper" => &["class", "class_key", "classKey", "cantrip", "cantrip_id", "cantripId"],
        "skilled" => &["skills", "skill_ids", "skillIds", "tools", "tool_ids", "toolIds"],
        "magic-initiate" => &["class", "class_key", "classKey", "cantrips", "cantrip_ids", "cantripIds", "spell", "spell_id", "spellId"],
        "ritual-caster" => &["class", "class_key", "classKey", "rituals", "ritual_ids", "ritualIds"],
        "elemental-adept" => &["damage_type", "damageType", "damage"],
        "linguist" => &["languages", "language_ids", "languageIds"],
        _ => &[],
    }
}

/// `characterCreationFeatFor(featId)`: копия черты или `None`.
pub fn character_creation_feat_for(feat_id: Option<&Value>) -> Option<Value> {
    feat_by_id(&text::lower(text::trim(&js::s(feat_id)))).cloned()
}

/// `listCharacterCreationFeats(context)`: все черты с отметкой, выполнены ли
/// требования для этого героя.
pub fn list_character_creation_feats(context: Option<&Value>) -> Value {
    let normalized = normalize_context(context);
    Value::Array(
        PHB_2014_FEATS
            .iter()
            .map(|feat| {
                let (met, unmet) = match &normalized {
                    Ok(context) => {
                        let unmet = prerequisite_result(feat, context);
                        (unmet.is_empty(), unmet)
                    }
                    Err((_, reason)) => (false, vec![reason.clone()]),
                };
                let mut entry = match feat {
                    Value::Object(map) => map.clone(),
                    _ => Map::new(),
                };
                entry.insert("prerequisites_met".into(), json!(met));
                entry.insert("unmet_prerequisites".into(), json!(unmet));
                Value::Object(entry)
            })
            .collect(),
    )
}

fn failure(code: &str, reason: &str, feat_id: &str) -> Value {
    json!({ "ok": false, "code": code, "reason": reason, "feat_id": feat_id })
}

/// `resolveCharacterCreationFeat(featId, choices = {}, context = {})`:
/// проверка выбора черты и её преимущества для листа героя.
pub fn resolve_character_creation_feat(feat_id: Option<&Value>, choices: Option<&Value>, context: Option<&Value>) -> Value {
    let id = text::lower(text::trim(&js::s(feat_id)));
    let Some(feat) = feat_by_id(&id) else {
        return failure("UNKNOWN_FEAT", "Такой черты PHB 2014 нет в каталоге", &id);
    };
    let context = match normalize_context(context) {
        Ok(context) => context,
        Err((code, reason)) => return failure(code, &reason, &id),
    };
    let empty = Map::new();
    let choices = match defined(choices) {
        None => &empty,
        Some(Value::Object(map)) => map,
        Some(_) => return failure("INVALID_CHOICES", "choices должен быть объектом", &id),
    };
    let allowed = choice_keys(&id);
    let unexpected: Vec<&str> = js::keys(choices).into_iter().map(String::as_str).filter(|key| !allowed.contains(key)).collect();
    if !unexpected.is_empty() {
        return failure("CHOICE_UNKNOWN_FIELD", &format!("choices содержит неподдерживаемые поля: {}", unexpected.join(", ")), &id);
    }
    let unmet = prerequisite_result(feat, &context);
    if !unmet.is_empty() {
        return json!({
            "ok": false, "code": "PREREQUISITE_NOT_MET", "reason": format!("Не выполнены требования: {}", unmet.join("; ")),
            "feat_id": id, "unmet_prerequisites": unmet,
        });
    }
    if id != "elemental-adept" && context.existing_feats.contains(&id) {
        return failure("FEAT_ALREADY_TAKEN", "Одну и ту же черту нельзя выбрать повторно", &id);
    }

    let mut benefits = empty_benefits();
    benefits.insert("static".into(), static_benefits(&id).unwrap_or_else(|| json!({})));
    match id.as_str() {
        "mobile" => {
            benefits.insert("speed_bonus".into(), json!(10));
        }
        "dual-wielder" => {
            benefits.insert("armor_class_bonus".into(), json!(1));
        }
        "alert" => {
            benefits.insert("initiative_bonus".into(), json!(5));
        }
        "observant" => {
            benefits.insert("passive_skill_bonuses".into(), json!({ "perception": 5, "investigation": 5 }));
        }
        "tough" => {
            benefits.insert("hit_point_maximum_bonus_per_level".into(), json!(2));
        }
        _ => {}
    }
    push_strings(&mut benefits, "armor_proficiencies", &armor_benefits(&id).iter().map(|armor| armor.to_string()).collect::<Vec<_>>());

    let mut resolved_choices = Map::new();
    if let Err((code, reason)) = resolve_fixed_ability(&id, &context, &mut benefits) {
        return failure(code, &reason, &id);
    }
    if ability_choices(&id).is_some() {
        match resolve_ability_choice(&id, choices, &context, &mut benefits) {
            Ok(choices) => resolved_choices.extend(choices),
            Err((code, reason)) => return failure(code, &reason, &id),
        }
    }
    let resolved = match id.as_str() {
        "skilled" => resolve_skilled(choices, &mut benefits),
        "weapon-master" => resolve_weapon_master(choices, &mut benefits),
        "martial-adept" => resolve_martial_adept(choices, &mut benefits),
        "magic-initiate" => resolve_magic_initiate(choices, &mut benefits),
        "ritual-caster" => resolve_ritual_caster(choices, &mut benefits),
        "spell-sniper" => resolve_spell_sniper(choices, &mut benefits),
        "elemental-adept" => resolve_elemental_adept(choices, &mut benefits),
        "linguist" => resolve_languages(choices, &context, &mut benefits),
        _ => Ok(Map::new()),
    };
    match resolved {
        Ok(choices) => resolved_choices.extend(choices),
        Err((code, reason)) => return failure(code, &reason, &id),
    }
    if id == "elemental-adept" {
        let chosen = js::s(resolved_choices.get("damage_type"));
        if previous_elemental_damage_types(&context).contains(&chosen) {
            return failure("FEAT_CHOICE_ALREADY_TAKEN", "Стихийный адепт: при повторном выборе нужна другая стихия", &id);
        }
    }
    if id == "resilient" {
        let ability = resolved_choices.get("ability").cloned().unwrap_or(Value::Null);
        benefit_list(&mut benefits, "saving_throw_proficiencies").push(ability);
    }
    json!({ "ok": true, "feat": feat, "choices": resolved_choices, "benefits": benefits, "mechanics_status": "partial" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve(id: &str, choices: Value, context: Value) -> Value {
        resolve_character_creation_feat(Some(&json!(id)), Some(&choices), Some(&context))
    }

    #[test]
    fn catalog_has_exactly_42_phb_feats() {
        assert_eq!(PHB_2014_FEATS.len(), 42);
        let ids = crate::support::unique_strings(PHB_2014_FEATS.iter().map(|feat| js::s(feat.get("id"))));
        assert_eq!(ids.len(), 42);
        assert!(PHB_2014_FEATS.iter().all(|feat| feat["source"] == json!("PHB2014") && feat["mechanics_status"] == json!("partial")));
        assert_eq!(character_creation_feat_for(Some(&json!("RESILIENT"))).map(|feat| feat["id"].clone()), Some(json!("resilient")));
    }

    #[test]
    fn asi_feats_are_exactly_the_phb_list() {
        let pattern = sk_core::re!(r"^Увеличьте .* на 1", "u");
        let mut asi: Vec<String> = PHB_2014_FEATS
            .iter()
            .filter(|feat| array(feat.get("description")).iter().any(|paragraph| text::test(pattern, paragraph.as_str().unwrap_or(""))))
            .map(|feat| js::s(feat.get("id")))
            .collect();
        asi.sort();
        let mut expected = vec![
            "actor", "athlete", "observant", "tavern-brawler", "lightly-armored", "moderately-armored", "heavily-armored", "durable",
            "weapon-master", "heavy-armor-master", "keen-mind", "resilient", "linguist",
        ];
        expected.sort();
        assert_eq!(asi, expected);
    }

    #[test]
    fn asi_choices_respect_options_and_cap() {
        assert_eq!(resolve_character_creation_feat(Some(&json!("actor")), None, None)["benefits"]["ability_increases"], json!({ "cha": 1 }));
        let athlete = resolve("athlete", json!({ "ability": "dex" }), json!({ "abilities": { "dex": 19 } }));
        assert_eq!(athlete["ok"], json!(true));
        assert_eq!(athlete["benefits"]["ability_increases"], json!({ "dex": 1 }));
        assert_eq!(resolve("athlete", json!({ "ability": "cha" }), json!({ "abilities": { "cha": 10 } }))["code"], json!("CHOICE_INVALID"));
        assert_eq!(resolve("keen-mind", json!({}), json!({ "abilities": { "int": 20 } }))["code"], json!("ABILITY_MAX_REACHED"));
        let master = resolve("heavy-armor-master", json!({}), json!({ "proficiency": { "armor": ["heavy"] } }));
        assert_eq!(master["benefits"]["ability_increases"], json!({ "str": 1 }));
    }

    #[test]
    fn magic_initiate_and_ritual_caster_limit_lists() {
        let initiate = resolve("magic-initiate", json!({ "class": "wizard", "cantrips": ["fire-bolt", "mage-hand"], "spell": "magic-missile" }), json!({}));
        assert_eq!(
            initiate["benefits"]["spellcasting"],
            json!({
                "source": "magic-initiate", "class_key": "wizard", "ability": "int", "cantrips": ["fire-bolt", "mage-hand"],
                "first_level_spell": "magic-missile", "once_per_long_rest": true, "uses_spell_slots": true,
            })
        );
        let ritual = resolve("ritual-caster", json!({ "class": "wizard", "rituals": ["alarm", "find-familiar"] }), json!({ "abilities": { "int": 12, "wis": 12 } }));
        assert_eq!(ritual["code"], json!("PREREQUISITE_NOT_MET"));
    }

    #[test]
    fn spell_availability_follows_phb_lists() {
        let wizard = json!({ "creationBenefits": { "expanded_spells": [], "domain_spells": [] } });
        let absorb = json!({ "id": "absorb-elements", "level": 1, "classes": ["wizard"] });
        assert!(!is_class_spell_available(Some(&absorb), "wizard", Some(&wizard)));
        let expanded = json!({ "creationBenefits": { "expanded_spells": ["absorb-elements"] } });
        assert!(is_class_spell_available(Some(&absorb), "wizard", Some(&expanded)));
        assert!(is_class_spell_available(Some(&absorb), "wizard", Some(&json!({}))));
    }
}

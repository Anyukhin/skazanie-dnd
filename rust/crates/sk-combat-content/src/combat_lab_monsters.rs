//! Перенос `server/combat-lab-monsters.mjs`: бестиарий D&D 2014 для боевого
//! стенда и встреч — стат-блок MM14 превращается в каталожную запись и во
//! врага движка (`enemyFrom2014`): хиты, КД, скорость, оружейные профили,
//! мультиатака, заклинания, защиты, тактические роли и честный список
//! того, что движок из стат-блока ещё не исполняет.
//!
//! Записи бестиария — JSON `data/compendia/dnd_5e_2014/monsters.json`;
//! модуль их не читает сам, а принимает запись параметром, как и JS.

use std::collections::HashMap;

use serde_json::{json, Map, Value};
use sk_combat_base::monster_actions::monster_area_action;
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, re, text};
use sk_geometry::actor_footprint::footprint_metadata_for_size;

use crate::combat_spells::{canonical_combat_spell_for, MONSTER_SPELL_AT_WILL};
use crate::jsv::{self, array, defined, is_str, nullish, num, prop};

/// Портрет привязан к полному ID проверенного стат-блока. Имена файлов не
/// выводятся из пользовательского ввода или другой редакции.
pub const DND_2014_MONSTER_IMAGES: [(&str, &str); 84] = [
    ("dnd_5e_2014:monster:goblin", "/assets/enemies/goblin.png"),
    ("dnd_5e_2014:monster:kobold", "/assets/enemies/kobold.png"),
    ("dnd_5e_2014:monster:hobgoblin", "/assets/enemies/hobgoblin.png"),
    ("dnd_5e_2014:monster:bugbear", "/assets/enemies/bugbear.png"),
    ("dnd_5e_2014:monster:orc", "/assets/enemies/orc.png"),
    ("dnd_5e_2014:monster:bandit", "/assets/enemies/bandit.png"),
    ("dnd_5e_2014:monster:bandit-captain", "/assets/enemies/bandit-captain.png"),
    ("dnd_5e_2014:monster:guard", "/assets/enemies/dnd-2014/guard.png"),
    ("dnd_5e_2014:monster:cultist", "/assets/enemies/dnd-2014/cultist.png"),
    ("dnd_5e_2014:monster:cult-fanatic", "/assets/enemies/dnd-2014/cult-fanatic.png"),
    ("dnd_5e_2014:monster:acolyte", "/assets/enemies/dnd-2014/acolyte.png"),
    ("dnd_5e_2014:monster:mage", "/assets/enemies/dnd-2014/mage.png"),
    ("dnd_5e_2014:monster:skeleton", "/assets/enemies/skeleton.png"),
    ("dnd_5e_2014:monster:zombie", "/assets/enemies/zombie.png"),
    ("dnd_5e_2014:monster:ghoul", "/assets/enemies/ghoul.png"),
    ("dnd_5e_2014:monster:ogre", "/assets/enemies/ogre.png"),
    ("dnd_5e_2014:monster:troll", "/assets/enemies/dnd-2014/troll.png"),
    ("dnd_5e_2014:monster:wolf", "/assets/enemies/wolf.png"),
    // Тот же зверь, что в бестиарии SRD 5.2.1: портрет общий.
    ("dnd_5e_2014:monster:giant-rat", "/assets/enemies/giant-rat.png"),
    ("dnd_5e_2014:monster:dire-wolf", "/assets/enemies/dire-wolf.png"),
    ("dnd_5e_2014:monster:giant-spider", "/assets/enemies/giant-spider.png"),
    ("dnd_5e_2014:monster:mimic", "/assets/enemies/dnd-2014/mimic.png"),
    ("dnd_5e_2014:monster:gelatinous-cube", "/assets/enemies/dnd-2014/gelatinous-cube.png"),
    ("dnd_5e_2014:monster:owlbear", "/assets/enemies/owlbear.png"),
    ("dnd_5e_2014:monster:young-red-dragon", "/assets/enemies/dnd-2014/young-red-dragon.png"),
    ("dnd_5e_2014:monster:gnoll", "/assets/enemies/gnoll-warrior.png"),
    ("dnd_5e_2014:monster:harpy", "/assets/enemies/dnd-2014/harpy.png"),
    ("dnd_5e_2014:monster:giant-boar", "/assets/enemies/giant-boar.png"),
    ("dnd_5e_2014:monster:minotaur", "/assets/enemies/dnd-2014/minotaur.png"),
    ("dnd_5e_2014:monster:veteran", "/assets/enemies/warrior-veteran.png"),
    ("dnd_5e_2014:monster:manticore", "/assets/enemies/manticore.png"),
    ("dnd_5e_2014:monster:hill-giant", "/assets/enemies/hill-giant.png"),
    ("dnd_5e_2014:monster:fire-elemental", "/assets/enemies/dnd-2014/fire-elemental.png"),
    ("dnd_5e_2014:monster:displacer-beast", "/assets/enemies/dnd-2014/displacer-beast.png"),
    ("dnd_5e_2014:monster:wyvern", "/assets/enemies/wyvern.png"),
    ("dnd_5e_2014:monster:commoner", "/assets/enemies/dnd-2014/commoner.png"),
    ("dnd_5e_2014:monster:crawling-claw", "/assets/enemies/dnd-2014/crawling-claw.png"),
    ("dnd_5e_2014:monster:homunculus", "/assets/enemies/dnd-2014/homunculus.png"),
    ("dnd_5e_2014:monster:lemure", "/assets/enemies/dnd-2014/lemure.png"),
    ("dnd_5e_2014:monster:awakened-shrub", "/assets/enemies/dnd-2014/awakened-shrub.png"),
    ("dnd_5e_2014:monster:giant-fire-beetle", "/assets/enemies/dnd-2014/giant-fire-beetle.png"),
    ("dnd_5e_2014:monster:hyena", "/assets/enemies/dnd-2014/hyena.png"),
    ("dnd_5e_2014:monster:jackal", "/assets/enemies/dnd-2014/jackal.png"),
    ("dnd_5e_2014:monster:spider", "/assets/enemies/dnd-2014/spider.png"),
    ("dnd_5e_2014:monster:scorpion", "/assets/enemies/dnd-2014/scorpion.png"),
    ("dnd_5e_2014:monster:animated-armor", "/assets/enemies/animated-armor.png"),
    ("dnd_5e_2014:monster:brown-bear", "/assets/enemies/brown-bear.png"),
    ("dnd_5e_2014:monster:imp", "/assets/enemies/dnd-2014/imp.png"),
    ("dnd_5e_2014:monster:lion", "/assets/enemies/lion.png"),
    ("dnd_5e_2014:monster:specter", "/assets/enemies/dnd-2014/specter.png"),
    ("dnd_5e_2014:monster:berserker", "/assets/enemies/berserker.png"),
    ("dnd_5e_2014:monster:ghast", "/assets/enemies/dnd-2014/ghast.png"),
    ("dnd_5e_2014:monster:minotaur-skeleton", "/assets/enemies/minotaur-skeleton.png"),
    ("dnd_5e_2014:monster:wererat", "/assets/enemies/dnd-2014/wererat.png"),
    ("dnd_5e_2014:monster:basilisk", "/assets/enemies/dnd-2014/basilisk.png"),
    ("dnd_5e_2014:monster:hell-hound", "/assets/enemies/dnd-2014/hell-hound.png"),
    ("dnd_5e_2014:monster:werewolf", "/assets/enemies/dnd-2014/werewolf.png"),
    ("dnd_5e_2014:monster:wight", "/assets/enemies/dnd-2014/wight.png"),
    ("dnd_5e_2014:monster:mummy", "/assets/enemies/dnd-2014/mummy.png"),
    ("dnd_5e_2014:monster:banshee", "/assets/enemies/dnd-2014/banshee.png"),
    ("dnd_5e_2014:monster:black-pudding", "/assets/enemies/dnd-2014/black-pudding.png"),
    ("dnd_5e_2014:monster:ghost", "/assets/enemies/dnd-2014/ghost.png"),
    ("dnd_5e_2014:monster:ettin", "/assets/enemies/ettin.png"),
    ("dnd_5e_2014:monster:succubus", "/assets/enemies/dnd-2014/succubus.png"),
    ("dnd_5e_2014:monster:red-dragon-wyrmling", "/assets/enemies/dnd-2014/red-dragon-wyrmling.png"),
    ("dnd_5e_2014:monster:chuul", "/assets/enemies/dnd-2014/chuul.png"),
    ("dnd_5e_2014:monster:couatl", "/assets/enemies/dnd-2014/couatl.png"),
    ("dnd_5e_2014:monster:flameskull", "/assets/enemies/dnd-2014/flameskull.png"),
    ("dnd_5e_2014:monster:helmed-horror", "/assets/enemies/dnd-2014/helmed-horror.png"),
    ("dnd_5e_2014:monster:air-elemental", "/assets/enemies/dnd-2014/air-elemental.png"),
    ("dnd_5e_2014:monster:earth-elemental", "/assets/enemies/earth-elemental.png"),
    ("dnd_5e_2014:monster:water-elemental", "/assets/enemies/dnd-2014/water-elemental.png"),
    ("dnd_5e_2014:monster:flesh-golem", "/assets/enemies/dnd-2014/flesh-golem.png"),
    ("dnd_5e_2014:monster:vampire-spawn", "/assets/enemies/dnd-2014/vampire-spawn.png"),
    ("dnd_5e_2014:monster:barbed-devil", "/assets/enemies/barbed-devil.png"),
    ("dnd_5e_2014:monster:gorgon", "/assets/enemies/dnd-2014/gorgon.png"),
    ("dnd_5e_2014:monster:chimera", "/assets/enemies/dnd-2014/chimera.png"),
    ("dnd_5e_2014:monster:cyclops", "/assets/enemies/dnd-2014/cyclops.png"),
    ("dnd_5e_2014:monster:medusa", "/assets/enemies/dnd-2014/medusa.png"),
    ("dnd_5e_2014:monster:mammoth", "/assets/enemies/dnd-2014/mammoth.png"),
    ("dnd_5e_2014:monster:vrock", "/assets/enemies/dnd-2014/vrock.png"),
    ("dnd_5e_2014:monster:drider", "/assets/enemies/dnd-2014/drider.png"),
    ("dnd_5e_2014:monster:young-white-dragon", "/assets/enemies/dnd-2014/young-white-dragon.png"),
    ("dnd_5e_2014:monster:young-brass-dragon", "/assets/enemies/dnd-2014/young-brass-dragon.png"),
];

/// Портрет стат-блока по полному ID (`DND_2014_MONSTER_IMAGES[id]`).
pub fn dnd_2014_monster_image(id: &str) -> Option<&'static str> {
    DND_2014_MONSTER_IMAGES.iter().find(|(key, _)| *key == id).map(|(_, image)| *image)
}

fn images_for_2014(record: &Value) -> Vec<&'static str> {
    let id = js::s(record.get("id"));
    let Some(primary) = dnd_2014_monster_image(&id) else {
        return Vec::new();
    };
    if id == "dnd_5e_2014:monster:goblin" {
        vec![primary, "/assets/enemies/goblin-minion.png"]
    } else {
        vec![primary]
    }
}

fn image_for_2014(record: &Value, index: f64) -> Option<&'static str> {
    let images = images_for_2014(record);
    let position = if index == 0.0 || index.is_nan() { 0.0 } else { index.trunc().abs() };
    let length = images.len().max(1) as f64;
    let slot = position % length;
    if !slot.is_finite() {
        return None;
    }
    images.get(slot as usize).copied()
}

const MIXED_MODE_WEAPONS: [&str; 7] = ["dagger", "javelin", "spear", "handaxe", "hand-axe", "dart", "net"];
const SUPPORTED_TRAITS: [&str; 6] = ["pack-tactics", "martial-advantage", "surprise-attack", "undead-fortitude", "aggressive", "web-walker"];
const SUPPORTED_ON_HIT_KEYS: [&str; 8] = ["save_ability", "save_dc", "condition", "duration", "damage_expression", "damage_type", "half_on_save", "target_size_max"];
const SUPPORTED_ON_HIT_CONDITIONS: [&str; 5] = ["grappled", "poisoned", "prone", "restrained", "paralyzed"];

fn movement_label(mode: &str) -> Option<&'static str> {
    match mode {
        "fly" => Some("полёта"),
        "climb" => Some("лазания"),
        "swim" => Some("плавания"),
        "burrow" => Some("рытья"),
        _ => None,
    }
}

fn nfkc_lower(value: &str) -> String {
    text::lower(text::trim(&text::nfkc(value)))
}

/// Стат-блок 2014 хранит защиты смешанным списком: обычные типы — строки,
/// условные физические защиты — объектами `{ types, condition, qualifier }`.
fn normalized_damage_defense_entries(value: Option<&Value>) -> Vec<Value> {
    array(value)
        .iter()
        .filter_map(|entry| match entry {
            Value::String(text) => {
                let normalized = nfkc_lower(text);
                (!normalized.is_empty()).then(|| Value::String(normalized))
            }
            Value::Object(map) => {
                let types: IndexSet<String> = array(map.get("types")).iter().map(|kind| nfkc_lower(&jsv::string(Some(kind)))).filter(|kind| !kind.is_empty()).collect();
                let condition = nfkc_lower(&js::s(map.get("condition")));
                if types.is_empty() || condition.is_empty() {
                    return None;
                }
                let qualifier = nfkc_lower(&js::s(map.get("qualifier")));
                let mut result = Map::new();
                result.insert("types".into(), json!(types.into_iter().collect::<Vec<_>>()));
                result.insert("condition".into(), Value::from(condition));
                if !qualifier.is_empty() {
                    result.insert("qualifier".into(), Value::from(qualifier));
                }
                Some(Value::Object(result))
            }
            _ => None,
        })
        .collect()
}

fn slug_of(record: &Value) -> String {
    let id = js::s(record.get("id"));
    let last = id.split(':').next_back().unwrap_or("").to_string();
    if last.is_empty() {
        "monster".into()
    } else {
        last
    }
}

/// `unique(values)`: `[...new Set(values.filter(Boolean).map(String))]`.
fn unique<'a>(values: impl IntoIterator<Item = &'a Value>) -> Vec<String> {
    let set: IndexSet<String> = values.into_iter().filter(|value| js::truthy(Some(value))).map(|value| jsv::string(Some(value))).collect();
    set.into_iter().collect()
}

fn unique_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let set: IndexSet<String> = values.into_iter().filter(|value| !value.is_empty()).collect();
    set.into_iter().collect()
}

fn kind_is(action: &Value, kind: &str) -> bool {
    is_str(action.get("kind"), kind)
}

/// Тактические метки — производная от полного MM14-стат-блока. Они не
/// заменяют числовую механику и нужны только планировщику и подбору состава.
pub fn monster_roles_for(record: &Value) -> Vec<String> {
    let actions = array(record.get("actions"));
    let traits = array(record.get("traits"));
    let profiles: Vec<&Value> = actions.iter().filter(|action| kind_is(action, "weapon_attack")).collect();
    let has_melee = profiles.iter().any(|action| weapon_modes(action).iter().any(|mode| mode == "melee"));
    let has_ranged = profiles.iter().any(|action| weapon_modes(action).iter().any(|mode| mode == "ranged"));
    let has_multiattack = actions.iter().any(|action| kind_is(action, "multiattack"));
    let has_area = actions.iter().any(|action| kind_is(action, "save_area"));
    let has_special = actions.iter().any(|action| kind_is(action, "special"));
    let has_spellcasting = js::truthy(record.get("spellcasting"));
    let ids: IndexSet<String> = traits.iter().map(|trait_| js::s(trait_.get("id"))).collect();
    let spell_ids: IndexSet<String> = array(jsv::path(Some(record), &["spellcasting", "spell_slots"]))
        .iter()
        .flat_map(|slot| array(slot.get("spells")).iter().map(|spell| js::s(spell.get("key"))))
        .collect();
    let mut roles: Vec<&str> = Vec::new();
    if has_spellcasting {
        roles.push("caster");
    }
    if ["bless", "cure-wounds", "healing-word", "sanctuary"].iter().any(|id| spell_ids.contains(*id)) {
        roles.push("support");
    }
    if has_area || has_special || profiles.iter().any(|action| js::truthy(action.get("on_hit"))) {
        roles.push("controller");
    }
    if has_ranged {
        roles.push("artillery");
    }
    if has_melee {
        roles.push("frontliner");
    }
    if has_multiattack {
        roles.push("multiattack");
    }
    let number_of = |keys: &[&str]| js::number(Some(defined(jsv::path(Some(record), keys)).unwrap_or(&Value::from(0))));
    if number_of(&["speed_ft", "fly"]) > 0.0 {
        roles.push("flying");
    }
    if number_of(&["speed_ft", "walk"]) >= 40.0 || ids.contains("pack-tactics") || ids.contains("surprise-attack") {
        roles.push("skirmisher");
    }
    if ids.contains("surprise-attack") || ids.contains("false-appearance") || ids.contains("shapechanger") {
        roles.push("ambusher");
    }
    if ["large", "huge", "gargantuan"].contains(&js::s(record.get("size")).as_str()) || number_of(&["abilities", "str"]) >= 18.0 {
        roles.push("brute");
    }
    if number_of(&["xp"]) <= 50.0 {
        roles.push("minion");
    }
    if number_of(&["xp"]) >= 1_800.0 || number_of(&["challenge_rating"]) >= 5.0 {
        roles.push("solo");
    }
    if roles.is_empty() {
        roles.push("frontliner");
    }
    unique_strings(roles.into_iter().map(str::to_string))
}

/// Режимы оружейных атак стат-блока: `melee`, `ranged`.
pub fn monster_attack_modes_for(record: &Value) -> Vec<String> {
    unique_strings(array(record.get("actions")).iter().filter(|action| kind_is(action, "weapon_attack")).flat_map(weapon_modes))
}

/// Разобранная формула урона `NdS±M` (`parseMonsterDamage`).
#[derive(Clone, Debug, PartialEq)]
pub struct MonsterDamage {
    pub count: f64,
    pub sides: f64,
    pub bonus: f64,
    pub expression: String,
}

impl MonsterDamage {
    /// Форма JS.
    pub fn to_value(&self) -> Value {
        json!({ "count": num(self.count), "sides": num(self.sides), "bonus": num(self.bonus), "expression": self.expression })
    }
}

/// `parseMonsterDamage(expression)`: строгая формула `NdS` с необязательной
/// прибавкой; иначе `None`.
pub fn parse_monster_damage(expression: Option<&Value>) -> Option<MonsterDamage> {
    let source = js::s(expression);
    let captures = re!(r"^(\d+)d(\d+)([+-]\d+)?$", "u").captures(&source).ok().flatten()?;
    let group = |index: usize| captures.get(index).map(|m| m.as_str());
    Some(MonsterDamage {
        count: js::parse_number(group(1).unwrap_or("")),
        sides: js::parse_number(group(2).unwrap_or("")),
        bonus: group(3).map_or(0.0, js::parse_number),
        expression: group(0).unwrap_or("").to_string(),
    })
}

fn weapon_modes(action: &Value) -> Vec<String> {
    let modes: Vec<String> = array(action.get("modes")).iter().map(|mode| jsv::string(Some(mode))).collect();
    unique_strings(modes.into_iter().filter(|mode| mode == "melee" || mode == "ranged"))
}

fn thrown_mode_for(action: &Value, mode: &str) -> bool {
    mode == "ranged" && weapon_modes(action).iter().any(|entry| entry == "melee") && MIXED_MODE_WEAPONS.contains(&text::lower(&js::s(action.get("id"))).as_str())
}

fn profile_id_for(action: &Value, mode: &str, first_mode: &str) -> String {
    let id = jsv::string(action.get("id"));
    if mode == first_mode {
        return id;
    }
    format!("{id}:{}", if thrown_mode_for(action, mode) { "thrown" } else { mode })
}

/// `typeof value === 'object' && value` — объект или массив.
fn object_like(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| value.is_object() || value.is_array())
}

/// `x?.includes(needle)` для строки (подстрока) и массива (элемент).
fn includes_text(value: Option<&Value>, needle: &str) -> bool {
    match value {
        Some(Value::String(text)) => text.contains(needle),
        Some(Value::Array(items)) => jsv::includes_str(items, needle),
        _ => false,
    }
}

fn map_on_hit(raw: Option<&Value>, secondary_damage: Option<&Value>) -> Option<Value> {
    let source = raw.filter(|raw| raw.is_object());
    let field = |key: &str| prop(source, key);
    let failure = object_like(field("on_failure")).filter(|value| js::truthy(Some(value)));
    let save = object_like(field("save"));
    let condition = nullish(nullish(field("condition"), prop(failure, "condition")), field("on_failure").filter(|value| value.is_string()));
    let mut result = Map::new();
    let save_ability = nullish(field("save_ability"), prop(save, "ability"));
    let save_dc = nullish(nullish(field("dc"), field("save_dc")), prop(save, "dc"));
    if js::truthy(save_ability) {
        result.insert("save_ability".into(), Value::from(jsv::string(save_ability)));
    }
    if js::present(save_dc) {
        result.insert("save_dc".into(), num(js::number(save_dc)));
    }
    let complex_grapple = js::truthy(field("max_grappled_targets")) || js::truthy(field("while_grappled")) || js::truthy(field("cannot_constrict_another_target"));
    let condition_text = condition.and_then(Value::as_str);
    if condition_text.is_some_and(|condition| SUPPORTED_ON_HIT_CONDITIONS.contains(&condition)) && !js::truthy(field("instead_of_damage")) && !complex_grapple {
        result.insert("condition".into(), Value::from(condition_text.unwrap_or_default()));
    }
    // СЛ освобождения из стат-блока («Высвободиться»): паутина паука — Сила 12.
    let escape_dc = js::number(nullish(prop(field("escape"), "dc"), field("escape_dc")));
    if js::truthy(result.get("condition")) && escape_dc.is_finite() && escape_dc > 0.0 {
        result.insert("escape_dc".into(), num(escape_dc));
    }
    let minutes = match defined(field("duration_minutes")) {
        Some(value) => js::number(Some(value)),
        None => {
            if is_str(prop(failure, "duration"), "1_minute") {
                1.0
            } else {
                0.0
            }
        }
    };
    let hours = js::number(Some(defined(field("duration_hours")).unwrap_or(&Value::from(0))));
    if minutes > 0.0 || hours > 0.0 {
        let rounds = jsv::max2(1.0, (minutes * 10.0 + hours * 600.0).ceil());
        result.insert("duration".into(), Value::from(format!("rounds:{}", js::f64_string(rounds))));
        result.insert("duration_minutes".into(), num(minutes + hours * 60.0));
    } else if js::present(field("duration")) && !is_str(field("duration"), "until-extinguished") {
        result.insert("duration".into(), field("duration").cloned().unwrap_or(Value::Null));
    }
    let repeated = nullish(field("repeat_save"), prop(failure, "repeat_save"));
    let repeats_at_end = match repeated {
        Some(Value::String(text)) => text.contains("end_"),
        Some(value) if js::truthy(Some(value)) => includes_text(prop(Some(value), "timing"), "end_"),
        _ => false,
    };
    if repeats_at_end {
        result.insert("repeat_save_timing".into(), Value::from("turn-end"));
    }
    let restrictions = field("target_restrictions");
    let mut exclusions: Vec<Value> = jsv::spread_items(defined(field("excluded_targets")));
    if array(restrictions).iter().any(|value| is_str(Some(value), "non_undead_creature") || is_str(Some(value), "non_undead")) {
        exclusions.push(Value::from("undead"));
    }
    if includes_text(restrictions, "non_elf") {
        exclusions.push(Value::from("elf"));
    }
    let excluded = unique(exclusions.iter());
    if !excluded.is_empty() {
        result.insert("excluded_targets".into(), json!(excluded));
    }
    if is_str(field("requires_target"), "humanoid") {
        result.insert("required_target_type".into(), Value::from("humanoid"));
    }
    if js::truthy(field("target_size_max")) {
        result.insert("target_size_max".into(), field("target_size_max").cloned().unwrap_or(Value::Null));
    }
    if js::truthy(field("at_0_hp_from_poison")) {
        result.insert("poison_on_zero".into(), field("at_0_hp_from_poison").cloned().unwrap_or(Value::Null));
    }
    // Горение тикает на последующем ходу; это не дополнительный немедленный урон.
    if !is_str(field("duration"), "until-extinguished") && !is_str(condition, "burning") {
        let extra = match object_like(field("damage")).filter(|value| js::truthy(Some(value))) {
            Some(damage) => Some(damage),
            None => secondary_damage,
        };
        if js::truthy(field("damage_expression")) || js::truthy(prop(extra, "expression")) {
            result.insert("damage_expression".into(), Value::from(jsv::string(nullish(field("damage_expression"), prop(extra, "expression")))));
            result.insert("damage_type".into(), Value::from(jsv::string(nullish(field("damage_type"), prop(extra, "type")))));
            result.insert("damage_on_save".into(), Value::Bool(js::truthy(save_ability)));
        }
        if js::truthy(field("half_on_save")) || is_str(field("save_success"), "half_damage") {
            result.insert("half_on_save".into(), Value::Bool(true));
        }
    }
    (js::truthy(result.get("condition")) || js::truthy(result.get("damage_expression"))).then_some(Value::Object(result))
}

/// Первый элемент `success` (массив или строка).
fn first_success(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::Array(items) => items.first().cloned(),
        Value::String(text) => text.chars().next().map(|ch| Value::String(ch.to_string())),
        _ => None,
    }
}

fn map_weapon_action(action: &Value, mode: &str, first_mode: &str) -> Value {
    let field = |key: &str| action.get(key);
    let damage = array(field("damage"));
    let primary = damage.first();
    let ranged = mode == "ranged";
    let parsed = parse_monster_damage(if ranged && js::truthy(field("ranged_damage")) { field("ranged_damage") } else { primary.and_then(|primary| primary.get("expression")) });
    let thrown = thrown_mode_for(action, mode);
    let range = object_like(field("range_ft")).filter(|value| js::truthy(Some(value)));
    let range_of = |first: &str, second: &str| js::number(Some(defined(nullish(prop(range, first), prop(range, second))).unwrap_or(&Value::from(5))));
    let reach = js::number(Some(defined(field("reach_ft")).unwrap_or(&Value::from(5))));
    let mut profile = Map::new();
    profile.insert("id".into(), Value::from(profile_id_for(action, mode, first_mode)));
    profile.insert("name".into(), Value::from(jsv::string(nullish(field("name_ru"), field("id")))));
    profile.insert("kind".into(), Value::from(if ranged { "ranged" } else { "melee" }));
    profile.insert("mode".into(), Value::from(if thrown { "thrown" } else { mode }));
    profile.insert("attack_modifier".into(), num(js::number(Some(defined(field("attack_modifier")).unwrap_or(&Value::from(0))))));
    profile.insert("damage_type".into(), Value::from(jsv::string(Some(defined(primary.and_then(|primary| primary.get("type"))).unwrap_or(&Value::from("untyped"))))));
    profile.insert("range_feet".into(), num(if ranged { range_of("long", "normal") } else { reach }));
    profile.insert("normal_range_feet".into(), num(if ranged { range_of("normal", "long") } else { reach }));
    if thrown {
        profile.insert("thrown".into(), Value::Bool(true));
        profile.insert("attack_kind".into(), Value::from("thrown"));
    }
    match &parsed {
        Some(parsed) => {
            profile.insert("damage_expression".into(), Value::from(parsed.expression.clone()));
            profile.insert("damage_dice".into(), num(parsed.sides));
            profile.insert("damage_bonus".into(), num(parsed.bonus));
        }
        None => {
            // Атака без урона (паутина Гигантского паука) — настоящее действие
            // с нулём урона, а не выдуманный запасной 1к4/1к6.
            let amount = primary.and_then(|primary| primary.get("amount")).filter(|amount| jsv::is_safe_integer(amount.as_f64().unwrap_or(f64::NAN)) && amount.is_number());
            profile.insert("damage_amount".into(), amount.cloned().unwrap_or(Value::from(0)));
        }
    }
    let extra_damage = damage.iter().skip(1).find(|entry| parse_monster_damage(entry.get("expression")).is_some());
    if let Some(on_hit) = map_on_hit(field("on_hit"), extra_damage) {
        profile.insert("on_hit".into(), on_hit);
    }
    if damage.len() > 1 {
        profile.insert("damage_components".into(), Value::Array(damage.to_vec()));
    }
    let success = jsv::path(Some(action), &["recharge", "success"]);
    if jsv::length(success).is_some_and(|length| length > 0) {
        profile.insert("recharge".into(), num(js::number(first_success(success).as_ref())));
    }
    if js::present(field("uses")) {
        profile.insert("uses".into(), num(js::number(field("uses"))));
    }
    let group = jsv::path(Some(action), &["recharge", "group"]);
    if js::truthy(group) {
        profile.insert("recharge_group".into(), Value::from(jsv::string(group)));
    }
    if is_str(field("target"), "one_prone_creature") {
        profile.insert("target_condition".into(), Value::from("prone"));
    }
    if includes_text(jsv::path(Some(action), &["on_hit", "target_restrictions"]), "willing") {
        profile.insert("target_any_conditions".into(), json!(["grappled", "incapacitated", "restrained"]));
    }
    if js::truthy(field("attack_type")) {
        profile.insert("attack_type".into(), Value::from(jsv::string(field("attack_type"))));
    }
    if js::truthy(field("mechanics_status")) {
        profile.insert("source_mechanics_status".into(), field("mechanics_status").cloned().unwrap_or(Value::Null));
    }
    Value::Object(profile)
}

struct ActionProfiles {
    first_mode: String,
    profile_ids: HashMap<String, String>,
}

fn action_profile_set(record: &Value) -> (Vec<Value>, HashMap<String, ActionProfiles>) {
    let mut profiles = Vec::new();
    let mut by_action = HashMap::new();
    for action in array(record.get("actions")) {
        if !kind_is(action, "weapon_attack") {
            continue;
        }
        let modes = weapon_modes(action);
        let Some(first_mode) = modes.first().cloned() else {
            continue;
        };
        profiles.extend(modes.iter().map(|mode| map_weapon_action(action, mode, &first_mode)));
        let profile_ids = modes.iter().map(|mode| (mode.clone(), profile_id_for(action, mode, &first_mode))).collect();
        by_action.insert(jsv::string(action.get("id")), ActionProfiles { first_mode, profile_ids });
    }
    (profiles, by_action)
}

/// Предел повторов шага мультиатаки: `Array.from({ length })` в JS упал бы
/// раньше, чем дошёл до таких чисел.
const MAX_STEP_REPEATS: f64 = 4_096.0;

fn multiattack_trait(record: &Value, by_action: &HashMap<String, ActionProfiles>) -> Option<Value> {
    let action = array(record.get("actions")).iter().find(|candidate| kind_is(candidate, "multiattack"))?;
    let sequences: Vec<Vec<String>> = array(action.get("sequences"))
        .iter()
        .map(|sequence| {
            array(Some(sequence))
                .iter()
                .flat_map(|step| {
                    let step_id = jsv::string(step.get("action_id"));
                    let mapped = by_action.get(&step_id);
                    let mode = match defined(step.get("mode")) {
                        Some(mode) => jsv::string(Some(mode)),
                        None => mapped.map_or_else(|| "melee".to_string(), |mapped| mapped.first_mode.clone()),
                    };
                    let profile_id = mapped.and_then(|mapped| mapped.profile_ids.get(&mode).cloned()).unwrap_or_else(|| step_id.clone());
                    let count = jsv::max2(1.0, jsv::number_or(step.get("count"), 1.0)).min(MAX_STEP_REPEATS).floor() as usize;
                    std::iter::repeat_n(profile_id, count)
                })
                .collect()
        })
        .collect();
    let sequence = sequences.first().cloned().unwrap_or_default();
    let mut trait_ = Map::new();
    trait_.insert("id".into(), Value::from("multiattack"));
    trait_.insert("name".into(), Value::from(jsv::string(Some(defined(action.get("name_ru")).unwrap_or(&Value::from("Мультиатака"))))));
    let attacks = sequence.len();
    trait_.insert("sequence".into(), json!(sequence));
    trait_.insert("attacks".into(), Value::from(attacks));
    if sequences.len() > 1 {
        trait_.insert("sequences".into(), json!(sequences));
    }
    if js::truthy(action.get("conditions")) {
        trait_.insert("sequence_conditions".into(), action.get("conditions").cloned().unwrap_or(Value::Null));
    }
    Some(Value::Object(trait_))
}

fn monster_spellcasting(record: &Value) -> Option<Value> {
    let source = record.get("spellcasting").filter(|source| js::truthy(Some(source)))?;
    let component_rules = |field: &str| -> Map<String, Value> {
        let traits = array(record.get("traits"));
        let by_field = |wanted: &str| traits.iter().find(|entry| is_str(jsv::path(Some(entry), &["mechanics", "spellcasting_field"]), wanted));
        let mechanics = by_field(field).or_else(|| by_field("spellcasting")).and_then(|entry| entry.get("mechanics")).filter(|mechanics| js::truthy(Some(mechanics)));
        let mut rules = Map::new();
        if let Some(mechanics) = mechanics {
            let list = |key: &str| defined(mechanics.get(key)).cloned().unwrap_or_else(|| json!([]));
            rules.insert("components_required".into(), list("components_required"));
            rules.insert("components_not_required".into(), list("components_not_required"));
        }
        rules
    };
    // Запись и её применения: `None` — «неограниченно», иначе число JS (и `NaN`).
    let mut spells: IndexMap<String, (Value, Option<f64>)> = IndexMap::new();
    for slot in array(source.get("spell_slots")) {
        let at_will = jsv::is_num(slot.get("level"), 0.0);
        let uses = if at_will { None } else { Some(js::number(Some(defined(slot.get("slots")).unwrap_or(&Value::from(0))))) };
        for spell in array(slot.get("spells")) {
            let id = js::s(spell.get("key"));
            if id.is_empty() {
                continue;
            }
            let replace = match spells.get(&id) {
                None => true,
                Some((_, previous)) => matches!((previous, uses), (Some(previous), Some(uses)) if uses > *previous),
            };
            if replace {
                let mut entry = Map::new();
                entry.insert("id".into(), Value::from(id.clone()));
                entry.insert("uses".into(), uses.map_or(Value::from(MONSTER_SPELL_AT_WILL), num));
                entry.insert("level".into(), num(js::number(slot.get("level"))));
                entry.extend(component_rules("spellcasting.spell_slots"));
                spells.insert(id, (Value::Object(entry), uses));
            }
        }
    }
    for group in array(source.get("innate_spells")) {
        for spell in array(group.get("spells")) {
            let id = js::s(spell.get("key"));
            if id.is_empty() {
                continue;
            }
            let at_will = is_str(group.get("uses"), "at-will");
            let uses = (!at_will).then(|| js::number(group.get("uses")));
            let mut entry = Map::new();
            entry.insert("id".into(), Value::from(id.clone()));
            entry.insert("uses".into(), uses.map_or(Value::from(MONSTER_SPELL_AT_WILL), num));
            entry.extend(component_rules("spellcasting.innate_spells"));
            spells.insert(id, (Value::Object(entry), uses));
        }
    }
    let ability = jsv::string(source.get("ability"));
    let attack_bonus = if js::present(source.get("attack_modifier")) {
        js::number(source.get("attack_modifier"))
    } else {
        ((js::number(prop(record.get("abilities"), &ability)) - 10.0) / 2.0).floor() + js::number(record.get("proficiency_bonus"))
    };
    let caster_level = if js::present(source.get("caster_level")) {
        js::number(source.get("caster_level"))
    } else {
        jsv::max2(1.0, jsv::number_or(record.get("challenge_rating"), 1.0))
    };
    let mut result = Map::new();
    result.insert("ability".into(), Value::from(ability));
    result.insert("save_dc".into(), num(js::number(source.get("save_dc"))));
    result.insert("attack_bonus".into(), num(attack_bonus));
    result.insert("spells".into(), Value::Array(spells.into_values().map(|(entry, _)| entry).collect()));
    // Исходная таблица общих ячеек 2014 нужна наблюдателю и
    // `monster_spellcasting_for`, который задаёт реальные пулы ресурсов.
    result.insert("spell_slots".into(), defined(source.get("spell_slots")).cloned().unwrap_or_else(|| json!([])));
    result.insert("caster_level".into(), num(caster_level));
    result.insert("class".into(), Value::from(js::s(source.get("class"))));
    Some(Value::Object(result))
}

/// Имя действия или черты для текста ограничения: `${name_ru ?? id}`.
fn name_of(entry: &Value) -> String {
    jsv::string(nullish(entry.get("name_ru"), entry.get("id")))
}

fn special_action_limitations(record: &Value) -> Vec<String> {
    array(record.get("actions"))
        .iter()
        .filter(|action| !kind_is(action, "weapon_attack") && !kind_is(action, "multiattack") && monster_area_action(Some(action)).is_none())
        .map(|action| format!("Действие «{}» статблока пока не исполняется планировщиком.", name_of(action)))
        .collect()
}

fn trait_limitations(record: &Value) -> Vec<String> {
    array(record.get("traits"))
        .iter()
        .filter(|trait_| !SUPPORTED_TRAITS.contains(&jsv::string(trait_.get("id")).as_str()))
        .map(|trait_| format!("Черта «{}» статблока пока не исполняется движком.", name_of(trait_)))
        .collect()
}

fn on_hit_limitations(record: &Value) -> Vec<String> {
    let mut limitations = Vec::new();
    for action in array(record.get("actions")) {
        if !kind_is(action, "weapon_attack") {
            continue;
        }
        let on_hit = action.get("on_hit");
        let condition = prop(on_hit, "condition");
        if js::truthy(condition) && !SUPPORTED_ON_HIT_CONDITIONS.contains(&jsv::string(condition).as_str()) {
            limitations.push(format!("Состояние «{}» после попадания «{}» записано, но его отдельный обработчик не подключён.", jsv::string(condition), name_of(action)));
        }
        if is_str(prop(on_hit, "duration"), "until-extinguished") {
            limitations.push(format!("Продолжительный эффект «{}» до тушения записан, но периодический урон движком не тикает.", name_of(action)));
        }
        if js::truthy(on_hit) {
            let keys: Vec<String> = match on_hit {
                Some(Value::Object(map)) => js::keys(map).into_iter().cloned().collect(),
                Some(Value::Array(items)) => (0..items.len()).map(|index| index.to_string()).collect(),
                Some(Value::String(text)) => (0..text.chars().count()).map(|index| index.to_string()).collect(),
                _ => Vec::new(),
            };
            if keys.iter().any(|key| !SUPPORTED_ON_HIT_KEYS.contains(&key.as_str()) && !["dc", "on_failure", "damage", "save_success"].contains(&key.as_str())) {
                limitations.push(format!("Дополнительные условия удара «{}» перенесены частично.", name_of(action)));
            }
        }
        let damage = array(action.get("damage"));
        let on_hit_damage = prop(on_hit, "damage");
        let independent = damage.len() > 2
            || (damage.len() > 1
                && js::truthy(on_hit_damage)
                && !damage.iter().skip(1).any(|component| {
                    jsv::strict_eq(component.get("expression"), prop(on_hit_damage, "expression")) && jsv::strict_eq(component.get("type"), prop(on_hit_damage, "type"))
                }));
        if independent {
            limitations.push(format!("Несколько независимых компонентов урона «{}» требуют отдельного обработчика.", name_of(action)));
        }
    }
    limitations
}

fn auxiliary_limitations(record: &Value) -> Vec<String> {
    let mut limitations = Vec::new();
    let speed = record.get("speed_ft");
    let extra_speeds: Vec<String> = match speed {
        Some(Value::Object(map)) => js::entries(map)
            .into_iter()
            .filter(|(mode, value)| mode.as_str() != "walk" && js::number(Some(value)) > 0.0)
            .map(|(mode, value)| format!("{} {} футов", movement_label(mode).unwrap_or(mode), js::f64_string(js::number(Some(value)))))
            .collect(),
        _ => Vec::new(),
    };
    if !extra_speeds.is_empty() {
        let walk = prop(speed, "walk");
        let fly = prop(speed, "fly");
        limitations.push(if !js::truthy(walk) && js::truthy(fly) {
            format!("Используется скорость полёта {} футов на плоской карте; высота и пролёт над препятствиями пока не моделируются.", js::f64_string(js::number(fly)))
        } else {
            format!("Дополнительная скорость ({}) сохранена в профиле, но планировщик NPC пока использует только скорость ходьбы.", extra_speeds.join(", "))
        });
    }
    for action in array(record.get("bonus_actions")) {
        if is_str(action.get("id"), "aggressive") {
            continue;
        }
        if is_str(action.get("id"), "nimble-escape") {
            limitations.push("Ловкое бегство позволяет отойти бонусным действием; скрытность бонусным действием пока не выбирается автоматически.".into());
            continue;
        }
        limitations.push(format!("Бонусное действие «{}» статблока сохранено, но пока не исполняется планировщиком NPC.", name_of(action)));
    }
    for reaction in array(record.get("reactions")) {
        limitations.push(format!("Реакция «{}» статблока сохранена, но пока не исполняется планировщиком NPC.", name_of(reaction)));
    }
    for action in array(record.get("legendary_actions")) {
        limitations.push(format!("Легендарное действие «{}» статблока сохранено, но пока не исполняется планировщиком NPC.", name_of(action)));
    }
    for action in array(record.get("lair_actions")) {
        limitations.push(format!("Действие логова «{}» статблока сохранено, но пока не исполняется планировщиком NPC.", name_of(action)));
    }
    limitations
}

/// Чего движок из стат-блока ещё не исполняет (`monsterLimitationsFor`).
pub fn monster_limitations_for(record: &Value) -> Vec<String> {
    let mut limitations = trait_limitations(record);
    limitations.extend(special_action_limitations(record));
    limitations.extend(on_hit_limitations(record));
    limitations.extend(auxiliary_limitations(record));
    if ["damage_resistances", "damage_immunities", "damage_vulnerabilities"].iter().any(|key| array(record.get(*key)).iter().any(|entry| !entry.is_string())) {
        limitations.push("Защиты с особыми условиями сохранены в статблоке; пока они не применяются в автоматическом бою.".into());
    }
    let multiattack = array(record.get("actions")).iter().find(|action| kind_is(action, "multiattack"));
    let spellcasting = record.get("spellcasting");
    let groups = array(prop(spellcasting, "spell_slots")).iter().chain(array(prop(spellcasting, "innate_spells")));
    for entry in groups {
        for known in array(entry.get("spells")) {
            let spell = canonical_combat_spell_for(known.get("key"), None);
            let support = spell.as_ref().and_then(|spell| spell.get("mechanicsSupport"));
            match &spell {
                Some(spell) if is_str(support, "verified") || is_str(support, "partial") => {
                    if !is_str(spell.get("actionType"), "action") {
                        limitations.push(format!("Заклинание «{}» с этим временем накладывания пока не выбирается тактикой NPC.", jsv::string(spell.get("name"))));
                    }
                }
                _ => {
                    let name = [known.get("name_ru"), spell.as_ref().and_then(|spell| spell.get("name"))].into_iter().find(|value| js::truthy(*value)).flatten().or(known.get("key"));
                    limitations.push(format!("Заклинание «{}» пока не исполняется движком.", jsv::string(name)));
                }
            }
        }
    }
    let actions = array(record.get("actions"));
    let conditional = multiattack.is_some_and(|multiattack| {
        array(multiattack.get("conditions")).iter().any(|condition| js::truthy(Some(condition)))
            || array(multiattack.get("sequences")).iter().any(|sequence| {
                array(Some(sequence)).iter().any(|step| !actions.iter().any(|action| jsv::strict_eq(action.get("id"), step.get("action_id")) && kind_is(action, "weapon_attack")))
            })
    });
    if conditional {
        limitations.push("Условные варианты мультиатаки и замены атак особыми действиями сохранены; в бою доступны проверенные оружейные последовательности.".into());
    }
    unique_strings(limitations)
}

/// Каталожная запись бестиария: настройки, полный стат-блок и варианты портрета.
pub fn monster_catalog_entry(record: &Value) -> Value {
    let roles = monster_roles_for(record);
    let attack_modes = monster_attack_modes_for(record);
    let limitations = monster_limitations_for(record);
    let mut entry = Map::new();
    entry.insert("id".into(), Value::from(jsv::string(record.get("id"))));
    entry.insert("name".into(), Value::from(jsv::string(record.get("name_ru"))));
    if let Some(image) = image_for_2014(record, 0.0) {
        entry.insert("image".into(), Value::from(image));
    }
    entry.insert("cr".into(), Value::from(jsv::string(record.get("challenge_rating"))));
    entry.insert("hp".into(), num(js::number(jsv::path(Some(record), &["hit_points", "average"]))));
    entry.insert("ac".into(), num(js::number(jsv::path(Some(record), &["armor_class", "value"]))));
    entry.insert("xp".into(), num(js::number(record.get("xp"))));
    entry.insert("creatureType".into(), Value::from(jsv::string(record.get("creature_type"))));
    entry.insert("size".into(), Value::from(jsv::string(record.get("size"))));
    entry.insert("roles".into(), json!(roles));
    entry.insert("attackModes".into(), json!(attack_modes));
    entry.insert("habitats".into(), json!(unique(array(record.get("habitats")))));
    entry.insert("speed_ft".into(), defined(record.get("speed_ft")).cloned().unwrap_or_else(|| json!({})));
    entry.insert("sourceUrl".into(), Value::from(jsv::string(record.get("source_url"))));
    entry.insert("images".into(), json!(images_for_2014(record)));
    entry.insert("statBlock".into(), record.clone());
    if !limitations.is_empty() {
        entry.insert("limitations".into(), json!(limitations));
    }
    Value::Object(entry)
}

/// `structuredClone(value ?? fallback)`.
fn clone_or(value: Option<&Value>, fallback: Value) -> Value {
    defined(value).cloned().unwrap_or(fallback)
}

/// Враг движка из стат-блока 2014 (`enemyFrom2014(record, position, index)`).
pub fn enemy_from_2014(record: &Value, position: Option<&Value>, index: f64) -> Value {
    let (profiles, by_action) = action_profile_set(record);
    let multiattack = multiattack_trait(record, &by_action);
    let bonus_traits = array(record.get("bonus_actions")).iter().filter(|action| is_str(action.get("id"), "nimble-escape") || is_str(action.get("id"), "aggressive")).cloned();
    let mut traits: Vec<Value> = array(record.get("traits")).to_vec();
    traits.extend(bonus_traits);
    traits.extend(multiattack);
    let primary = profiles.first().cloned();
    let primary_dice = parse_monster_damage(primary.as_ref().and_then(|primary| primary.get("damage_expression")));
    let spellcasting = monster_spellcasting(record);
    let limitations = monster_limitations_for(record);
    let resistances = normalized_damage_defense_entries(record.get("damage_resistances"));
    let immunities = normalized_damage_defense_entries(record.get("damage_immunities"));
    let vulnerabilities = normalized_damage_defense_entries(record.get("damage_vulnerabilities"));
    let id = format!("enemy-{}-{}", slug_of(record), js::f64_string(index + 1.0));
    let max_hp = num(js::number(jsv::path(Some(record), &["hit_points", "average"])));
    let speed = record.get("speed_ft");
    let walk = prop(speed, "walk");
    let fly = prop(speed, "fly");
    let mut enemy = Map::new();
    enemy.insert("id".into(), Value::from(id));
    enemy.insert("name".into(), Value::from(jsv::string(record.get("name_ru"))));
    if let Some(image) = image_for_2014(record, index) {
        enemy.insert("image".into(), Value::from(image));
    }
    enemy.insert("hp".into(), max_hp.clone());
    enemy.insert("maxHp".into(), max_hp);
    enemy.insert("armor".into(), num(js::number(jsv::path(Some(record), &["armor_class", "value"]))));
    let speed_value = [walk, fly].into_iter().find(|value| js::truthy(*value)).flatten().cloned().unwrap_or(Value::from(0));
    enemy.insert("speed".into(), num(js::number(Some(&speed_value))));
    if !js::truthy(walk) && js::truthy(fly) {
        enemy.insert("movement_mode".into(), Value::from("fly"));
    }
    enemy.insert("speed_ft".into(), clone_or(speed, json!({})));
    enemy.insert("proficiency".into(), num(js::number(record.get("proficiency_bonus"))));
    enemy.insert("initiativeBonus".into(), num(js::number(record.get("initiative_bonus"))));
    if let Some(primary) = &primary {
        enemy.insert("attackBonus".into(), num(js::number(Some(defined(primary.get("attack_modifier")).unwrap_or(&Value::from(0))))));
        let (dice, bonus) = primary_dice.as_ref().map_or((Value::from(0), Value::from(0)), |dice| (num(dice.sides), num(dice.bonus)));
        enemy.insert("damageDice".into(), dice);
        enemy.insert("damageBonus".into(), bonus);
        if let Some(kind) = primary.get("damage_type") {
            enemy.insert("damageType".into(), kind.clone());
        }
        enemy.insert("attackRange".into(), num(js::number(primary.get("range_feet"))));
    }
    if let Some(abilities) = record.get("abilities") {
        enemy.insert("abilities".into(), abilities.clone());
    }
    enemy.insert("creature_type".into(), Value::from(jsv::string(record.get("creature_type"))));
    enemy.insert("subtypes".into(), clone_or(record.get("subtypes"), json!([])));
    enemy.insert("size".into(), Value::from(jsv::string(record.get("size"))));
    enemy.insert("footprint".into(), footprint_metadata_for_size(record.get("size")).to_value());
    enemy.insert("roles".into(), json!(monster_roles_for(record)));
    enemy.insert("attack_modes".into(), json!(monster_attack_modes_for(record)));
    enemy.insert("habitats".into(), json!(unique(array(record.get("habitats")))));
    for key in ["saving_throws", "skills", "senses", "languages"] {
        enemy.insert(key.into(), clone_or(record.get(key), json!({})));
    }
    for (key, entries) in [("damage_resistances", resistances), ("damage_immunities", immunities), ("damage_vulnerabilities", vulnerabilities)] {
        if !entries.is_empty() {
            enemy.insert(key.into(), Value::Array(entries));
        }
    }
    if jsv::length(record.get("condition_immunities")).is_some_and(|length| length > 0) {
        enemy.insert("condition_immunities".into(), record.get("condition_immunities").cloned().unwrap_or(Value::Null));
    }
    enemy.insert("traits".into(), Value::Array(traits));
    for key in ["bonus_actions", "reactions", "legendary_actions", "lair_actions"] {
        enemy.insert(key.into(), clone_or(record.get(key), json!([])));
    }
    enemy.insert("action_profiles".into(), Value::Array(profiles));
    enemy.insert("attack_profile".into(), primary.unwrap_or(Value::Null));
    if let Some(spellcasting) = spellcasting {
        enemy.insert("spellcasting".into(), spellcasting);
    }
    let special: Vec<Value> = array(record.get("actions")).iter().filter(|action| !kind_is(action, "weapon_attack") && !kind_is(action, "multiattack")).cloned().collect();
    if !special.is_empty() {
        enemy.insert("special_actions".into(), Value::Array(special));
    }
    let stat_block_id = jsv::string(record.get("id"));
    let source_url = jsv::string(record.get("source_url"));
    let challenge_rating = jsv::string(record.get("challenge_rating"));
    let xp = num(js::number(record.get("xp")));
    enemy.insert("stat_block_id".into(), Value::from(stat_block_id.clone()));
    enemy.insert(
        "provenance".into(),
        json!({
            "kind": "server-owned-dnd-2014-stat-block",
            "ruleset_id": "dnd_5e_2014",
            "stat_block_id": stat_block_id,
            "source_version": jsv::string(record.get("version")),
            "source_url": source_url,
            "challenge_rating": challenge_rating,
            "xp": xp,
        }),
    );
    enemy.insert("source_url".into(), Value::from(source_url));
    enemy.insert("challenge_rating".into(), Value::from(challenge_rating));
    enemy.insert("xp".into(), xp);
    enemy.insert("mechanics_status".into(), Value::from(if limitations.is_empty() { "verified" } else { "partial" }));
    if !limitations.is_empty() {
        enemy.insert("limitations".into(), json!(limitations));
    }
    enemy.insert("x".into(), num(js::number(prop(position, "x"))));
    enemy.insert("y".into(), num(js::number(prop(position, "y"))));
    enemy.insert("alive".into(), Value::Bool(true));
    Value::Object(enemy)
}

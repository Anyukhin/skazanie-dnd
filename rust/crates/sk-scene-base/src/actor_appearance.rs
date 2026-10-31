//! Перенос `server/actor-appearance.mjs`: публичный облик фигурки.
//!
//! Облик выводится из небольшого публичного словаря: профиль фигурки (воин,
//! маг, плут, гоблин, скелет, зверь, дракон), грубый вид оружия, `loadout`
//! видимой экипировки и рост по категории размера. Модулю никогда не нужны
//! стат-блок существа или закрытый инвентарь NPC; замаскированная личность
//! по типу существа не восстанавливается.

use serde_json::{Map, Value};
use sk_core::fancy_regex::Regex;
use sk_core::{js, re, text};

use crate::equipment_visuals::{normalize_public_loadout, public_loadout_for_items, EQUIPMENT_VISUAL_SCHEMA_VERSION};
use crate::util::{js_string, nullish, str_of, utf16_head};

/// Версия снимка облика (`ACTOR_APPEARANCE_SCHEMA_VERSION`).
pub const ACTOR_APPEARANCE_SCHEMA_VERSION: i64 = EQUIPMENT_VISUAL_SCHEMA_VERSION;
pub const ACTOR_APPEARANCE_LEGACY_SCHEMA_VERSION: i64 = 1;
pub const ACTOR_APPEARANCE_PROFILES: [&str; 7] = ["warrior", "mage", "rogue", "goblin", "skeleton", "beast", "dragon"];
pub const ACTOR_APPEARANCE_EQUIPMENT: [&str; 7] = ["unknown", "unarmed", "sword", "sword-shield", "bow", "staff", "dagger"];
/// Категории размера D&D: по ним 3D-доска выбирает рост фигурки.
pub const ACTOR_APPEARANCE_STATURES: [&str; 6] = ["tiny", "small", "medium", "large", "huge", "gargantuan"];

const HIDDEN_VISIBILITIES: [&str; 2] = ["gm_only", "npc_private"];
const PUBLIC_VISIBILITIES: [&str; 2] = ["public", "party"];
const VISIBILITY_KEYS: [&str; 3] = ["visibility", "visibility_level", "visibilityLevel"];
const PRIVATE_FLAGS: [&str; 8] = ["hidden", "private", "gm_only", "npc_private", "secret", "unrevealed", "private_notes", "gm_notes"];

/// Маленькие расы героя (PHB 2014): полурослик и гном. Дварф — не «гном».
fn small_species() -> &'static Regex {
    re!(r"полурослик|гном|halfling|gnome", "u")
}

/// Звери с собственными фигурками и членистоногие. Только целым словом:
/// «Крысолов» — человек, «Осада» — не оса, «Жуков» — не жук.
fn beast_words() -> &'static Regex {
    re!(r"(?<!\p{L})(?:rat|spider|wasp|frog|toad|snake|viper|scorpion|centipede|beetle|крыс[аы]?|паук[и]?|паучиха|ос[аы]|шершень|лягушк[аи]|жаб[аы]|зме[йяи]|гадюк[аи]|питон|удав|скорпион[ы]?|сороконожк[аи]|многоножк[аи]|жук[и]?)(?!\p{L})", "iu")
}

/// `String(value ?? '').normalize('NFKC').trim().slice(0, maximum).toLocaleLowerCase('ru-RU')`.
fn text_of(value: Option<&Value>, maximum: usize) -> String {
    lower_head(&str_of(value), maximum)
}

fn lower_head(value: &str, maximum: usize) -> String {
    text::lower(utf16_head(text::trim(&text::nfkc(value)), maximum))
}

/// Запись открыта всем: объявленная видимость только `public`/`party`, без
/// флагов скрытности.
pub fn public_appearance_record(value: &Value) -> bool {
    let Value::Object(record) = value else { return false };
    let declared: Vec<String> =
        VISIBILITY_KEYS.iter().filter(|key| js::present(record.get(**key))).map(|key| text_of(record.get(*key), 40)).collect();
    declared.iter().all(|visibility| PUBLIC_VISIBILITIES.contains(&visibility.as_str()))
        && !declared.iter().any(|visibility| HIDDEN_VISIBILITIES.contains(&visibility.as_str()))
        && !PRIVATE_FLAGS.iter().any(|key| js::truthy(record.get(*key)))
}

/// `${item?.catalog_id ?? item?.catalogId ?? ''} ${item?.name ?? ''}`.
fn item_description(item: &Value) -> String {
    let catalog = str_of(nullish(item.get("catalog_id"), item.get("catalogId")));
    let name = str_of(item.get("name"));
    lower_head(&format!("{catalog} {name}"), 240)
}

fn item_is_shield(item: &Value) -> bool {
    public_appearance_record(item) && text::test(re!(r"(?:^|[:\s_-])shield(?:$|[:\s_-])|щит", "iu"), &item_description(item))
}

fn item_is_weapon(item: &Value) -> bool {
    if !public_appearance_record(item) {
        return false;
    }
    if text_of(item.get("type"), 40) == "weapon" {
        return true;
    }
    text::test(
        re!(r"(?:^|[:\s])\b((?:short|long)?sword|scimitar|rapier|dagger|shortbow|longbow|(?:hand|heavy|light)?-?crossbow|quarterstaff)\b", "iu"),
        &item_description(item),
    )
}

fn bow_pattern() -> &'static Regex {
    re!(r"\b(?:shortbow|longbow|bow)\b|(?:^|\s)(?:короткий|длинный)?\s*лук(?:$|\s)", "iu")
}

fn sword_pattern() -> &'static Regex {
    re!(r"shortsword|longsword|sword|scimitar|rapier|меч|сабл|рапир|скимитар", "iu")
}

fn equipment_for_item(item: &Value) -> &'static str {
    if !public_appearance_record(item) {
        return "unknown";
    }
    let description = item_description(item);
    if description.is_empty() {
        return "unknown";
    }
    if text::test(bow_pattern(), &description) {
        return "bow";
    }
    if text::test(re!(r"quarterstaff|посох", "iu"), &description) {
        return "staff";
    }
    if text::test(re!(r"dagger|кинжал", "iu"), &description) {
        return "dagger";
    }
    if text::test(sword_pattern(), &description) {
        return "sword";
    }
    "unknown"
}

fn public_shield_in(items: &[Value]) -> bool {
    items.iter().any(|item| js::is_true(item.get("equipped")) && item_is_shield(item))
}

fn as_list(items: Option<&Value>) -> &[Value] {
    match items {
        Some(Value::Array(list)) => list,
        _ => &[],
    }
}

/// Грубый вид оружия по публичному снимку экипировки (старый словарь из семи
/// вариантов, его рисуют прежние клиенты).
pub fn equipment_for_public_items(items: Option<&Value>) -> &'static str {
    let worn: Vec<Value> =
        as_list(items).iter().filter(|item| public_appearance_record(item) && js::is_true(item.get("equipped"))).cloned().collect();
    let weapons: Vec<&Value> = worn.iter().filter(|item| item_is_weapon(item)).collect();
    if weapons.is_empty() {
        return "unarmed";
    }
    if weapons.len() != 1 {
        return "unknown";
    }
    let equipment = equipment_for_item(weapons[0]);
    if equipment == "sword" && public_shield_in(&worn) {
        "sword-shield"
    } else {
        equipment
    }
}

/// Старый `attack_visual` v1 без изменения формы и новый снимок v2 с
/// безопасной `loadout`. `None` — `undefined`.
pub fn normalize_attack_visual(value: Option<&Value>) -> Option<Value> {
    let Some(Value::Object(record)) = value else { return None };
    let version = record.get("version").and_then(Value::as_f64);
    let equipment = js_string(record.get("equipment"));
    let known = ACTOR_APPEARANCE_EQUIPMENT.contains(&equipment.as_str());
    if version == Some(ACTOR_APPEARANCE_LEGACY_SCHEMA_VERSION as f64) {
        if !known {
            return None;
        }
        return Some(serde_json::json!({ "version": 1, "equipment": equipment }));
    }
    if version != Some(ACTOR_APPEARANCE_SCHEMA_VERSION as f64) || !known {
        return None;
    }
    let mut result = Map::new();
    result.insert("version".into(), Value::from(ACTOR_APPEARANCE_SCHEMA_VERSION));
    result.insert("equipment".into(), Value::String(equipment));
    result.insert("loadout".into(), Value::Object(normalize_public_loadout(record.get("loadout"))));
    Some(Value::Object(result))
}

fn with_equipped(item: &Value, equipped: bool) -> Value {
    js::spread(item, serde_json::json!({ "equipped": equipped }))
}

/// Инвентарь для снимка атаки: выбранная вещь надета, прежняя вещь того же
/// слота снята. Авторитетный инвентарь не меняется.
fn attack_items_with_selected(items: Option<&Value>, item: Option<&Value>) -> Vec<Value> {
    let source = as_list(items);
    let Some(item) = item else { return source.to_vec() };
    let selected = public_loadout_for_items(&Value::Array(vec![with_equipped(item, true)]), None);
    let remaining: Vec<Value> = source
        .iter()
        .map(|candidate| {
            if !js::truthy(candidate.get("equipped")) {
                return candidate.clone();
            }
            let slots = public_loadout_for_items(&Value::Array(vec![candidate.clone()]), None);
            if selected.keys().any(|slot| slots.contains_key(slot)) {
                with_equipped(candidate, false)
            } else {
                candidate.clone()
            }
        })
        .collect();
    let id_of = |value: &Value| str_of(nullish(value.get("id"), value.get("item_id")));
    let item_id = id_of(item);
    if item_id.is_empty() {
        let mut next = remaining;
        next.push(with_equipped(item, true));
        return next;
    }
    let mut replaced = false;
    let mut next: Vec<Value> = remaining
        .into_iter()
        .map(|candidate| {
            if id_of(&candidate) != item_id {
                return candidate;
            }
            replaced = true;
            with_equipped(&candidate, true)
        })
        .collect();
    if !replaced {
        next.push(with_equipped(item, true));
    }
    next
}

/// Снимок облика атаки: из авторитетной вещи (`item`, `items`) или из
/// публичного текста действия NPC (`actionName`, `itemName`, `attackKind`,
/// `unarmed`). Закрытая привязка оружия NPC намеренно не принимается.
pub fn attack_visual_for(input: Option<&Value>) -> Value {
    let empty = Value::Object(Map::new());
    let input = match input {
        Some(value @ Value::Object(_)) => value,
        // `attackVisualFor()` и `attackVisualFor(null)`: в JS второй случай бросает TypeError.
        _ => &empty,
    };
    let item = input.get("item").filter(|value| value.is_object());
    let action_name = nullish(input.get("actionName"), input.get("itemName"));
    let mut equipment = match item {
        Some(item) => equipment_for_item(item),
        None if js::is_true(input.get("unarmed")) => "unarmed",
        None => equipment_for_action(action_name, input.get("attackKind")),
    };
    let items = attack_items_with_selected(input.get("items"), item);
    if item.is_some() && equipment == "sword" && public_shield_in(&items) {
        equipment = "sword-shield";
    }
    let mut loadout = public_loadout_for_items(&Value::Array(items), None);
    if item.is_none() && !matches!(input.get("items"), Some(Value::Array(_))) {
        // Для NPC — только точное публичное название действия; когти, укус и
        // неоднозначное имя не создают оружие.
        let mut action = Map::new();
        action.insert("id".into(), Value::String("public-action".into()));
        if let Some(name) = action_name {
            action.insert("name".into(), name.clone());
        }
        action.insert("type".into(), Value::String("weapon".into()));
        action.insert("equipped".into(), Value::Bool(true));
        let public_action = public_loadout_for_items(&Value::Array(vec![Value::Object(action)]), None);
        if js::truthy(public_action.get("main_hand").and_then(|hand| hand.get("model_key"))) {
            loadout = public_action;
        }
    }
    let mut result = Map::new();
    result.insert("version".into(), Value::from(ACTOR_APPEARANCE_SCHEMA_VERSION));
    result.insert("equipment".into(), Value::String(equipment.into()));
    result.insert("loadout".into(), Value::Object(loadout));
    Value::Object(result)
}

fn equipment_for_action(action_name: Option<&Value>, attack_kind: Option<&Value>) -> &'static str {
    let action = text_of(action_name, 240);
    let kind = str_of(attack_kind);
    let known_kind = ["melee", "ranged", "thrown"].contains(&kind.as_str());
    if text::test(re!(r"безоруж|unarmed|fist|кулак", "iu"), &action) {
        return if !known_kind || kind == "melee" { "unarmed" } else { "unknown" };
    }
    if text::test(bow_pattern(), &action) {
        return if !known_kind || kind == "ranged" { "bow" } else { "unknown" };
    }
    if text::test(re!(r"quarterstaff|staff|посох", "iu"), &action) {
        return if !known_kind || kind == "melee" { "staff" } else { "unknown" };
    }
    if text::test(re!(r"dagger|кинжал", "iu"), &action) {
        return if !known_kind || kind != "ranged" { "dagger" } else { "unknown" };
    }
    if text::test(sword_pattern(), &action) {
        if known_kind && kind != "melee" {
            return "unknown";
        }
        return if text::test(re!(r"щит|shield", "iu"), &action) { "sword-shield" } else { "sword" };
    }
    // Одного вида атаки недостаточно: ranged может быть заклинанием.
    "unknown"
}

fn looks_masked_identity(actor: &Value) -> bool {
    let flag = |key: &str| js::is_true(actor.get(key));
    if flag("masked")
        || flag("is_masked")
        || flag("identity_masked")
        || flag("identityMasked")
        || flag("masked_identity")
        || js::is_false(actor.get("identified"))
        || js::is_false(actor.get("identity_known"))
    {
        return true;
    }
    let name = text_of(actor.get("name"), 160);
    name.is_empty()
        || text::test(
            re!(r"^(?:\?+|unknown|неизвестн|неопознан|безымянн|скрыт|маскир|masked|тайн(?:ый|ое|ая)|враг|существо|creature|enemy)(?:\s|$)", "iu"),
            &name,
        )
}

/// Дракон — только целым словом и не как добыча («драконоборец» — не дракон).
fn dragon_word() -> &'static Regex {
    re!(r"(?<!\p{L})(?:dragons?|wyrm(?:ling)?s?|drakes?|wyverns?|дракон(?:а|у|ом|е|ы|ов|ам|ами|ах|ица|ицы)?|виверн\p{L}*)(?!\p{L})", "iu")
}

fn dragon_as_prey() -> &'static Regex {
    re!(r"(?:dragon[\s-]*(?:slayer|hunter)s?|(?:охотни\p{L}*|убийц\p{L}*|истребител\p{L}*|победител\p{L}*)[\s-]+(?:на[\s-]+)?дракон\p{L}*)", "giu")
}

/// Текст называет самого дракона, а не того, кто на драконов охотится.
pub fn names_dragon(value: Option<&Value>) -> bool {
    names_dragon_str(&str_of(value))
}

fn names_dragon_str(value: &str) -> bool {
    text::test(dragon_word(), &text::replace_all(dragon_as_prey(), value, " "))
}

/// Грубый профиль фигурки из публичных полей личности и класса.
/// `creature_type` читается только после проверки маски.
pub fn actor_profile_for(actor: Option<&Value>) -> &'static str {
    let empty = Value::Object(Map::new());
    let actor = actor.filter(|value| !value.is_null()).unwrap_or(&empty);
    let kind = text_of(actor.get("kind"), 30);
    let identity = if kind == "hero" {
        let class = nullish(nullish(nullish(actor.get("characterClass"), actor.get("character_class")), actor.get("class_id")), actor.get("role"));
        text_of(class, 160)
    } else {
        text_of(nullish(actor.get("role"), actor.get("name")), 160)
    };
    if kind != "hero" && looks_masked_identity(actor) {
        return if kind == "summon" { "beast" } else { "warrior" };
    }
    // Тип существа уже публичен в карточке врага.
    if kind != "hero" && text_of(actor.get("creature_type"), 40) == "dragon" {
        return "dragon";
    }
    if text::test(re!(r"goblin|гоблин", "iu"), &identity) {
        return "goblin";
    }
    if text::test(re!(r"skeleton|скелет|undead|нежить|зомби", "iu"), &identity) {
        return "skeleton";
    }
    if names_dragon_str(&identity) {
        return "dragon";
    }
    if text::test(re!(r"beast|звер|wolf|волк|bear|медвед|boar|кабан", "iu"), &identity) || text::test(beast_words(), &identity) {
        return "beast";
    }
    // Зверь по стат-блоку — тоже публичная строка карточки врага.
    if kind != "hero" && text_of(actor.get("creature_type"), 40) == "beast" {
        return "beast";
    }
    if text::test(re!(r"wizard|mage|sorcer|warlock|cleric|druid|волшеб|маг|чарод|колдун|жрец|друид", "iu"), &identity) {
        return "mage";
    }
    if text::test(re!(r"rogue|ranger|scout|плут|следопыт|разведчик", "iu"), &identity) {
        return "rogue";
    }
    if kind == "summon" {
        "beast"
    } else {
        "warrior"
    }
}

/// Категория размера для роста фигурки: у врага — `size` стат-блока, у героя
/// — раса. `None` — неизвестно, доска берёт рост по площади.
pub fn actor_stature_for(kind: Option<&Value>, actor: Option<&Value>) -> Option<&'static str> {
    let size = text_of(actor.and_then(|actor| actor.get("size")), 20);
    if let Some(stature) = ACTOR_APPEARANCE_STATURES.iter().find(|known| **known == size) {
        return Some(stature);
    }
    if text_of(kind, 30) == "hero" && text::test(small_species(), &text_of(actor.and_then(|actor| actor.get("species")), 120)) {
        return Some("small");
    }
    None
}

const PROFILE_FIELDS: [&str; 13] = [
    "name",
    "role",
    "creature_type",
    "characterClass",
    "character_class",
    "class_id",
    "masked",
    "is_masked",
    "identity_masked",
    "identityMasked",
    "masked_identity",
    "identified",
    "identity_known",
];

/// Публичный облик фигурки: `{ version: 2, profile, equipment, loadout, stature? }`.
/// Средний рост в облик не пишется.
pub fn actor_appearance_for(kind: Option<&Value>, actor: Option<&Value>) -> Value {
    let empty = Value::Object(Map::new());
    let source = actor.filter(|value| value.is_object()).unwrap_or(&empty);
    let appearance_kind = text_of(kind, 30);
    let mut profile_input = Map::new();
    profile_input.insert("kind".into(), Value::String(appearance_kind.clone()));
    for key in PROFILE_FIELDS {
        if let Some(value) = source.get(key) {
            profile_input.insert(key.into(), value.clone());
        }
    }
    let profile = actor_profile_for(Some(&Value::Object(profile_input)));
    let hero = appearance_kind == "hero";
    let equipment = if hero { equipment_for_public_items(source.get("inventory")) } else { "unknown" };
    let loadout = if hero { public_loadout_for_items(source.get("inventory").unwrap_or(&Value::Null), None) } else { Map::new() };
    let stature = actor_stature_for(Some(&Value::String(appearance_kind)), Some(source));
    let mut result = Map::new();
    result.insert("version".into(), Value::from(ACTOR_APPEARANCE_SCHEMA_VERSION));
    result.insert("profile".into(), Value::String(profile.into()));
    result.insert("equipment".into(), Value::String(equipment.into()));
    result.insert("loadout".into(), Value::Object(loadout));
    if let Some(stature) = stature.filter(|stature| *stature != "medium") {
        result.insert("stature".into(), Value::String(stature.into()));
    }
    Value::Object(result)
}

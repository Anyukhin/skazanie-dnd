//! Перенос `server/scene-interactions.mjs`: что сервер умеет делать с
//! реквизитом сцены — каталог видов (`container`, `relic`, `campfire`, `lore`,
//! `corpse`, `furnishing`), детерминированная metadata пропа и выбор 2–4
//! точек интереса, определение объекта (замок, ловушка, проверка, деталь),
//! находка, разбор свободного текста в операцию и рассказ о результате.
//!
//! Всё выводится из сида карты и полей пропа (SHA-256 строки), поэтому replay
//! и повторная генерация дают те же точки интереса. Пропы на входе — рыхлый
//! JSON той же формы, что в JS (`prop.id`, `prop.assetId`, `prop.footprint`);
//! тактическая карта зовёт те же функции через [`PropRef`].

use serde_json::{Map, Value};
use sk_combat_content::scene_hazards::{ignite_definition_for, scene_hazard_verbs_for, topple_definition_for};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{hash, js, re, text};

pub const SCENE_INTERACTION_POLICY_ID: &str = "skazanie:scene-interactions-v1";

/// Запись каталога: вид, синонимы `assetId` и обычные операции.
struct CatalogRecord {
    kind: &'static str,
    aliases: &'static [&'static str],
    verbs: &'static [&'static str],
}

/// Каталог видов. `lockpick` у контейнера объявлен безусловно: запертость
/// выводится из сида, и кнопка не должна её выдавать.
const CATALOG: [CatalogRecord; 6] = [
    CatalogRecord {
        kind: "container",
        aliases: &["chest", "barrel", "crate", "sarcophagus", "urn", "crypt_niche", "reliquary", "cupboard", "wardrobe", "basket", "keg"],
        verbs: &["inspect", "open", "lockpick", "take"],
    },
    CatalogRecord { kind: "relic", aliases: &["altar", "rune", "statue", "roadside_shrine", "brazier"], verbs: &["inspect", "use"] },
    CatalogRecord { kind: "campfire", aliases: &["campfire"], verbs: &["inspect", "use"] },
    CatalogRecord {
        kind: "lore",
        aliases: &["bookshelf", "table", "fallen_log", "tree_stump", "boulder", "rubble_heap", "stalagmite", "milestone"],
        verbs: &["inspect"],
    },
    CatalogRecord { kind: "corpse", aliases: &["bones", "bone_pile", "grave", "corpse"], verbs: &["inspect", "take"] },
    CatalogRecord {
        kind: "furnishing",
        aliases: &[
            "bar_counter", "bar_shelf", "shelf_wall", "pillar", "cart", "market_stall", "haystack", "woodpile", "firewood_stack", "broom", "cobweb", "banner", "temple_banner", "rug", "bed",
            "bunk_bed", "bench", "prayer_bench", "chandelier", "royal_throne",
        ],
        verbs: &["inspect"],
    },
];

/// Таблица деталей осмотра: `вид:номер` → `{ id, text }`.
const DETAIL_TABLE: [(&str, &str, &str); 16] = [
    ("container:0", "scratched-mark", "На внутренней стороне крышки вырезан знак прежнего владельца."),
    ("container:1", "false-bottom", "Под грубой обивкой заметно неглубокое двойное дно."),
    ("container:2", "recently-moved", "Пыль вокруг предмета нарушена совсем недавно."),
    ("relic:0", "old-consecration", "Знаки указывают на старое защитное посвящение."),
    ("relic:1", "warning-glyph", "Надпись предупреждает не тревожить печать без нужды."),
    ("relic:2", "pilgrim-sign", "Символ оставлен паломниками и отмечает безопасный путь."),
    ("campfire:0", "safe-rest", "Очаг можно безопасно использовать для короткого привала."),
    ("lore:0", "route-note", "Среди записей найдено упоминание обходного пути."),
    ("lore:1", "name-in-margin", "На полях несколько раз повторено одно и то же имя."),
    ("lore:2", "hurried-message", "Короткая запись оставлена в спешке незадолго до событий сцены."),
    ("corpse:0", "cause-of-death", "Следы позволяют определить вероятную причину гибели."),
    ("corpse:1", "travel-token", "При останках сохранился знак, связанный с местным путём."),
    ("corpse:2", "defensive-wounds", "Положение останков говорит о внезапном нападении."),
    ("furnishing:0", "dry-and-brittle", "Вещь рассохлась и держится на честном слове."),
    ("furnishing:1", "recently-disturbed", "Пыль вокруг сдвинута: обстановку здесь недавно трогали."),
    ("furnishing:2", "poorly-braced", "Опора стоит косо — сильного толчка она не выдержит."),
];

/// Ключи наград по виду; у обстановки наград нет.
const REWARD_KEYS: [(&str, &[&str]); 5] = [
    ("container", &["generic-cache", "traveler-cache", "guard-cache"]),
    ("relic", &["minor-ward"]),
    ("campfire", &["short-rest"]),
    ("lore", &["written-clue"]),
    ("corpse", &["personal-effects"]),
];

/// Русские слова предметов (`ASSET_ALIASES_RU`); первое — именительный падеж.
const ASSET_ALIASES_RU: [(&str, &[&str]); 49] = [
    ("chest", &["сундук", "ларец"]),
    ("barrel", &["бочка", "бочку", "бочке"]),
    ("crate", &["ящик", "ящика", "ящике"]),
    ("sarcophagus", &["саркофаг", "саркофага", "саркофаге"]),
    ("urn", &["урна", "урну", "урне"]),
    ("crypt_niche", &["ниша", "нишу", "нише"]),
    ("reliquary", &["ковчег", "ковчега", "ковчеге", "реликварий"]),
    ("altar", &["алтарь", "алтаря"]),
    ("rune", &["руна", "руну", "руне"]),
    ("statue", &["статуя", "статую", "статуе"]),
    ("roadside_shrine", &["святилище", "святилища", "святилище"]),
    ("brazier", &["жаровня", "жаровню", "жаровне", "чаша с огнём"]),
    ("campfire", &["костёр", "костер", "очаг"]),
    ("chandelier", &["люстра", "люстру", "люстре"]),
    ("bookshelf", &["полка", "полку", "шкаф", "книги"]),
    ("table", &["стол", "стола", "столе"]),
    ("royal_throne", &["королевский трон", "трон", "трона", "троне"]),
    ("fallen_log", &["бревно", "бревна", "бревне"]),
    ("tree_stump", &["пень", "пня", "пне"]),
    ("boulder", &["валун", "валуна", "валуне", "камень", "камня", "камне"]),
    ("rubble_heap", &["завал", "завала", "завале", "обломки"]),
    ("stalagmite", &["сталагмит", "сталагмита", "сталагмите", "нарост"]),
    ("milestone", &["верстовой столб", "указатель", "указателя"]),
    ("bones", &["кости", "останки", "скелет"]),
    ("bone_pile", &["кости", "останки", "скелет"]),
    ("grave", &["могила", "могилу", "могиле"]),
    ("corpse", &["труп", "трупа", "теле"]),
    ("cupboard", &["буфет", "буфета", "буфете"]),
    ("wardrobe", &["платяной шкаф", "гардероб", "гардероба"]),
    ("basket", &["корзина", "корзину", "корзине"]),
    ("keg", &["бочонок", "бочонка", "бочонке"]),
    ("bar_counter", &["стойка", "стойку", "стойке"]),
    ("bar_shelf", &["полка за стойкой"]),
    ("shelf_wall", &["стеллаж", "стеллажа", "стеллаже"]),
    ("pillar", &["колонна", "колонну", "колонне"]),
    ("cart", &["телега", "телегу", "телеге"]),
    ("market_stall", &["лоток", "лотка", "прилавок"]),
    ("haystack", &["сено", "сена", "стог", "стога"]),
    ("woodpile", &["поленница", "поленницу", "поленнице"]),
    ("firewood_stack", &["дрова", "дров", "вязанка"]),
    ("broom", &["метла", "метлу", "метле"]),
    ("cobweb", &["паутина", "паутину", "паутине"]),
    ("banner", &["полотнище", "знамя", "флаг"]),
    ("temple_banner", &["храмовое полотнище"]),
    ("rug", &["ковёр", "ковер", "ковра", "ковре"]),
    ("bed", &["кровать", "кровати", "постель", "постели"]),
    ("bunk_bed", &["койка", "койку", "койке", "нары"]),
    ("bench", &["скамья", "скамью", "скамье", "скамейка", "лавка"]),
    ("prayer_bench", &["молитвенная скамья"]),
];

/// У чего молятся: подмножество `relic`.
const SHRINE_ALIASES: [&str; 3] = ["altar", "roadside_shrine", "statue"];

const FALLBACK_ASSETS: [&str; 5] = ["chest", "altar", "campfire", "bookshelf", "bone_pile"];

/// Синонимы каталога от длинных к коротким (устойчиво): так `bar_shelf`
/// узнаётся раньше `shelf`-подобных совпадений.
static ALIAS_MATCHERS: std::sync::LazyLock<Vec<&'static str>> = std::sync::LazyLock::new(|| {
    let mut aliases: Vec<&'static str> = CATALOG.iter().flat_map(|entry| entry.aliases.iter().copied()).collect();
    aliases.sort_by(|left, right| right.len().cmp(&left.len()));
    aliases
});

/// Строки пропа, которые читает каталог: `String(prop.id ?? '')` и
/// `String(prop.assetId ?? '')` (поле не объекта — пустая строка).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PropRef {
    pub id: String,
    pub asset_id: String,
}

impl PropRef {
    /// Из рыхлого JSON (`prop?.id`, `prop?.assetId`).
    pub fn from_value(prop: Option<&Value>) -> Self {
        Self { id: js::s(field(prop, "id")), asset_id: js::s(field(prop, "assetId")) }
    }

    pub fn new(id: impl Into<String>, asset_id: impl Into<String>) -> Self {
        Self { id: id.into(), asset_id: asset_id.into() }
    }
}

/// `prop?.[key]` для рыхлого JSON: поле есть только у объекта.
fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|object| object.get(key))
}

/// `clean(value, maximum)`: `String(value ?? '').trim().slice(0, maximum)` над
/// уже приведённой строкой.
fn clean(value: &str, maximum: usize) -> String {
    text::head(text::trim(value), maximum)
}

fn clean_value(value: Option<&Value>, maximum: usize) -> String {
    clean(&js::s(value), maximum)
}

/// `hashNumber(value)`: первые 8 hex-знаков SHA-256 как число.
fn hash_number(value: &str) -> u64 {
    let digest = hash::sha256_hex(clean(value, 1_000));
    u64::from_str_radix(&digest[..8], 16).unwrap_or(0)
}

/// `(?:^|[\/_-])alias(?:$|[\/_-])` без регулярного выражения.
fn alias_matches(value: &str, alias: &str) -> bool {
    let separator = |ch: Option<char>| matches!(ch, Some('/' | '_' | '-'));
    let mut start = 0;
    while let Some(found) = value[start..].find(alias) {
        let position = start + found;
        let before = position == 0 || separator(value[..position].chars().next_back());
        let end = position + alias.len();
        let after = end == value.len() || separator(value[end..].chars().next());
        if before && after {
            return true;
        }
        start = position + value[position..].chars().next().map_or(1, char::len_utf8);
        if start > value.len() {
            break;
        }
    }
    false
}

/// `assetAlias(assetId)` над приведённой строкой.
fn asset_alias(asset_id: &str) -> Option<&'static str> {
    let value = text::lower(&clean(asset_id, 120));
    ALIAS_MATCHERS.iter().copied().find(|alias| alias_matches(&value, alias))
}

fn catalog_record(asset_id: &str) -> Option<&'static CatalogRecord> {
    let alias = asset_alias(asset_id)?;
    CATALOG.iter().find(|entry| entry.aliases.contains(&alias))
}

fn reward_keys(kind: &str) -> &'static [&'static str] {
    REWARD_KEYS.iter().find(|(key, _)| *key == kind).map_or(&[], |(_, keys)| keys)
}

fn is_point_of_interest_kind(kind: &str) -> bool {
    REWARD_KEYS.iter().any(|(key, _)| *key == kind)
}

fn asset_value(asset_id: &str) -> Value {
    Value::String(asset_id.to_string())
}

fn is_shrine_str(asset_id: &str) -> bool {
    asset_alias(asset_id).is_some_and(|alias| SHRINE_ALIASES.contains(&alias))
}

fn shrine_verbs_str(asset_id: &str) -> Vec<&'static str> {
    if is_shrine_str(asset_id) {
        vec!["pray"]
    } else {
        Vec::new()
    }
}

/// Святыня ли это (`isSceneShrineAsset`).
pub fn is_scene_shrine_asset(asset_id: Option<&Value>) -> bool {
    is_shrine_str(&js::s(asset_id))
}

/// Глаголы святыни (`sceneShrineVerbsFor`): `["pray"]` или пусто.
pub fn scene_shrine_verbs_for(asset_id: Option<&Value>) -> Vec<&'static str> {
    shrine_verbs_str(&js::s(asset_id))
}

/// `sceneInteractionFallbackAssets()`.
pub fn scene_interaction_fallback_assets() -> Vec<String> {
    FALLBACK_ASSETS.iter().map(|asset| asset.to_string()).collect()
}

/// `sceneInteractionRewardKinds()`: виды, за которыми есть находка или знание.
pub fn scene_interaction_reward_kinds() -> Vec<String> {
    REWARD_KEYS.iter().map(|(kind, _)| kind.to_string()).collect()
}

/// `sceneInteractionAssetIds()`: все синонимы каталога в порядке каталога.
pub fn scene_interaction_asset_ids() -> Vec<String> {
    CATALOG.iter().flat_map(|entry| entry.aliases.iter().map(|alias| alias.to_string())).collect()
}

/// Русская подпись предмета (`sceneObjectLabelFor`); пустая строка — подписи нет.
pub fn scene_object_label_for(asset_id: Option<&Value>) -> String {
    let topple = topple_definition_for(asset_id);
    let mut hazard = clean_value(topple.as_ref().and_then(|definition| definition.get("mass")), 60);
    if hazard.is_empty() {
        let ignite = ignite_definition_for(asset_id);
        hazard = clean_value(ignite.as_ref().and_then(|definition| definition.get("what")), 60);
    }
    if !hazard.is_empty() {
        return hazard;
    }
    let Some(alias) = asset_alias(&js::s(asset_id)) else { return String::new() };
    ASSET_ALIASES_RU
        .iter()
        .find(|(key, _)| *key == alias)
        .and_then(|(_, words)| words.first())
        .map_or_else(String::new, |word| clean(word, 60))
}

/// Запись каталога пропа (`sceneInteractionCatalogEntry`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SceneInteractionCatalogEntry {
    pub kind: &'static str,
    pub verbs: Vec<&'static str>,
}

impl SceneInteractionCatalogEntry {
    /// Форма JS: `{ kind, verbs }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("kind".into(), Value::String(self.kind.into()));
        object.insert("verbs".into(), js::strings_value(self.verbs.iter().copied()));
        Value::Object(object)
    }
}

/// `sceneInteractionCatalogEntry(assetId)`.
pub fn scene_interaction_catalog_entry(asset_id: Option<&Value>) -> Option<SceneInteractionCatalogEntry> {
    catalog_entry_str(&js::s(asset_id))
}

fn catalog_entry_str(asset_id: &str) -> Option<SceneInteractionCatalogEntry> {
    catalog_record(asset_id).map(|entry| SceneInteractionCatalogEntry { kind: entry.kind, verbs: entry.verbs.to_vec() })
}

/// Metadata пропа (`interactionMetadataForProp`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InteractionMetadata {
    pub kind: &'static str,
    pub verbs: Vec<&'static str>,
    pub point_of_interest: bool,
    pub detail_key: String,
    pub reward_key: String,
}

impl InteractionMetadata {
    /// Форма JS: `{ kind, verbs, pointOfInterest, detailKey, rewardKey }`.
    pub fn to_json(&self) -> Value {
        Value::Object(self.json_fields())
    }

    fn json_fields(&self) -> Map<String, Value> {
        let mut object = Map::new();
        object.insert("kind".into(), Value::String(self.kind.into()));
        object.insert("verbs".into(), js::strings_value(self.verbs.iter().copied()));
        object.insert("pointOfInterest".into(), Value::Bool(self.point_of_interest));
        object.insert("detailKey".into(), Value::String(self.detail_key.clone()));
        object.insert("rewardKey".into(), Value::String(self.reward_key.clone()));
        object
    }
}

fn metadata_variant(map_seed: &str, prop: &PropRef, modulus: usize) -> usize {
    let seed = format!("{}:{}:{}", clean(map_seed, 160), clean(&prop.id, 160), clean(&prop.asset_id, 160));
    (hash_number(&seed) % modulus.max(1) as u64) as usize
}

/// `interactionMetadataForProp({ mapSeed, prop, pointOfInterest })` над
/// рыхлым пропом. Переданный `prop.interaction` намеренно не читается.
pub fn interaction_metadata_for_prop(map_seed: &str, prop: Option<&Value>, point_of_interest: bool) -> Option<InteractionMetadata> {
    interaction_metadata_for_ref(map_seed, &PropRef::from_value(prop), point_of_interest)
}

/// То же над уже приведёнными строками пропа.
pub fn interaction_metadata_for_ref(map_seed: &str, prop: &PropRef, point_of_interest: bool) -> Option<InteractionMetadata> {
    let catalog = catalog_record(&prop.asset_id)?;
    if clean(&prop.id, 120).is_empty() {
        return None;
    }
    let detail_variants = if catalog.kind == "campfire" { 1 } else { 3 };
    let detail_key = format!("{}:{}", catalog.kind, metadata_variant(map_seed, prop, detail_variants));
    let rewards = reward_keys(catalog.kind);
    let reward_key = if rewards.is_empty() {
        String::new()
    } else {
        format!("{}:{}", catalog.kind, rewards[metadata_variant(&format!("{map_seed}:reward"), prop, rewards.len())])
    };
    let asset = asset_value(&prop.asset_id);
    let hazard_verbs: Vec<&'static str> = scene_hazard_verbs_for(Some(&asset)).into_iter().filter(|verb| !catalog.verbs.contains(verb)).collect();
    let shrine_verbs: Vec<&'static str> = shrine_verbs_str(&prop.asset_id).into_iter().filter(|verb| !catalog.verbs.contains(verb)).collect();
    let mut verbs = catalog.verbs.to_vec();
    verbs.extend(hazard_verbs);
    verbs.extend(shrine_verbs);
    Some(InteractionMetadata { kind: catalog.kind, verbs, point_of_interest, detail_key, reward_key })
}

/// `sceneInteractionMetadata({ mapSeed, props })`: metadata поддержанных
/// пропов по `id` в порядке отбора; ровно 2–4 точки интереса (или все, если
/// кандидатов меньше двух).
pub fn scene_interaction_metadata(map_seed: &str, props: &[Value]) -> IndexMap<String, InteractionMetadata> {
    let refs: Vec<PropRef> = props.iter().map(|prop| PropRef::from_value(Some(prop))).collect();
    scene_interaction_metadata_for_refs(map_seed, &refs)
}

/// То же над приведёнными строками пропов.
pub fn scene_interaction_metadata_for_refs(map_seed: &str, props: &[PropRef]) -> IndexMap<String, InteractionMetadata> {
    let seed = clean(map_seed, 160);
    let mut supported: Vec<(&PropRef, &'static str, u64)> = props
        .iter()
        .filter(|prop| !clean(&prop.id, 120).is_empty())
        .filter_map(|prop| catalog_record(&prop.asset_id).map(|entry| (prop, entry.kind)))
        .map(|(prop, kind)| (prop, kind, hash_number(&format!("{seed}:poi:{}:{}", clean(&prop.id, 160), clean(&prop.asset_id, 160)))))
        .collect();
    supported.sort_by(|left, right| left.2.cmp(&right.2).then_with(|| text::locale_compare(&clean(&left.0.id, 160), &clean(&right.0.id, 160))));
    let candidates: Vec<&(&PropRef, &'static str, u64)> = supported.iter().filter(|candidate| is_point_of_interest_kind(candidate.1)).collect();
    let desired = if candidates.is_empty() {
        0
    } else {
        candidates.len().min(2 + (hash_number(&format!("{seed}:poi-count")) % 3) as usize)
    };
    let mut selected_entries: Vec<&PropRef> = Vec::new();
    let mut selected_assets: IndexSet<String> = IndexSet::new();
    for candidate in &candidates {
        let asset_id = clean(&candidate.0.asset_id, 120);
        if selected_assets.contains(&asset_id) {
            continue;
        }
        selected_entries.push(candidate.0);
        selected_assets.insert(asset_id);
        if selected_entries.len() >= desired {
            break;
        }
    }
    let mut selected_ids: IndexSet<String> = selected_entries.iter().map(|prop| clean(&prop.id, 120)).collect();
    for candidate in &candidates {
        if selected_entries.len() >= desired {
            break;
        }
        let prop_id = clean(&candidate.0.id, 120);
        if selected_ids.contains(&prop_id) {
            continue;
        }
        selected_entries.push(candidate.0);
        selected_ids.insert(prop_id);
    }
    let selected: IndexSet<String> = selected_entries.iter().map(|prop| clean(&prop.id, 120)).collect();
    let mut result = IndexMap::new();
    for (prop, _, _) in &supported {
        let id = clean(&prop.id, 120);
        let point_of_interest = selected.contains(&id);
        if let Some(metadata) = interaction_metadata_for_ref(map_seed, prop, point_of_interest) {
            result.insert(id, metadata);
        }
    }
    result
}

fn detail_for(key: &str) -> Option<(&'static str, &'static str)> {
    DETAIL_TABLE.iter().find(|(entry, ..)| *entry == key).map(|(_, id, text)| (*id, *text))
}

fn check_value(ability: &str, skill: &str, dc: u64, purpose: &str) -> Value {
    let mut object = Map::new();
    object.insert("ability".into(), Value::String(ability.into()));
    object.insert("skill".into(), Value::String(skill.into()));
    object.insert("dc".into(), Value::from(dc));
    object.insert("purpose".into(), Value::String(purpose.into()));
    Value::Object(object)
}

/// `sceneInteractionDefinition({ mapSeed, props, propId })`: полное серверное
/// определение объекта — замок, ловушка, проверка осмотра, деталь, эффект.
pub fn scene_interaction_definition(map_seed: &str, props: &[Value], prop_id: Option<&Value>) -> Option<Value> {
    let wanted = clean_value(prop_id, 120);
    let prop = props.iter().find(|candidate| clean_value(field(Some(candidate), "id"), 120) == wanted)?;
    let prop_ref = PropRef::from_value(Some(prop));
    let metadata = scene_interaction_metadata(map_seed, props).shift_remove(&clean(&prop_ref.id, 120))?;
    let alias = asset_alias(&prop_ref.asset_id);
    let seed = format!("{}:{}:{}", clean(map_seed, 160), clean(&prop_ref.id, 160), clean(&prop_ref.asset_id, 160));
    let difficulty = 10 + (hash_number(&format!("{seed}:dc")) % 3) * 2;
    let container = metadata.kind == "container";
    let locked = container && hash_number(&format!("{seed}:locked")) % 3 == 0;
    let trapped = container && hash_number(&format!("{seed}:trap")) % 4 == 0;
    let detail = detail_for(&metadata.detail_key).or_else(|| detail_for(&format!("{}:0", metadata.kind)));
    let asset = asset_value(&prop_ref.asset_id);
    let hazard_verbs = scene_hazard_verbs_for(Some(&asset));
    let shrine_verbs = shrine_verbs_str(&prop_ref.asset_id);
    let mut verbs = metadata.verbs.clone();
    verbs.extend(hazard_verbs.iter().copied().filter(|verb| !metadata.verbs.contains(verb)));
    verbs.extend(shrine_verbs.iter().copied().filter(|verb| !metadata.verbs.contains(verb) && !hazard_verbs.contains(verb)));
    let mut object = metadata.json_fields();
    object.insert("verbs".into(), js::strings_value(verbs));
    object.insert("shrine".into(), Value::Bool(is_shrine_str(&prop_ref.asset_id)));
    object.insert("topple".into(), topple_definition_for(Some(&asset)).unwrap_or(Value::Null));
    object.insert("ignite".into(), ignite_definition_for(Some(&asset)).unwrap_or(Value::Null));
    object.insert("alias".into(), alias.map_or(Value::Null, |alias| Value::String(alias.into())));
    let initial_state = if container {
        if locked {
            "locked"
        } else {
            "closed"
        }
    } else {
        "idle"
    };
    object.insert("initialState".into(), Value::String(initial_state.into()));
    let purpose = format!("scene-object:{}:inspect", metadata.kind);
    let check = match metadata.kind {
        "relic" => check_value("int", if matches!(alias, Some("altar" | "statue")) { "religion" } else { "arcana" }, difficulty, &purpose),
        "lore" | "corpse" => check_value("wis", "investigation", difficulty, &purpose),
        _ => Value::Null,
    };
    object.insert("check".into(), check);
    object.insert(
        "lock".into(),
        if locked { check_value("dex", "sleight_of_hand", difficulty, "scene-object:container:lock") } else { Value::Null },
    );
    let trap = if trapped {
        let mut damage = Map::new();
        damage.insert("expression".into(), Value::String("1d4".into()));
        damage.insert("type".into(), Value::String("piercing".into()));
        damage.insert("purpose".into(), Value::String("scene-object:container:trap-damage".into()));
        let mut trap = Map::new();
        trap.insert("notice".into(), check_value("wis", "perception", difficulty, "scene-object:container:trap"));
        trap.insert("damage".into(), Value::Object(damage));
        Value::Object(trap)
    } else {
        Value::Null
    };
    object.insert("trap".into(), trap);
    object.insert(
        "detail".into(),
        detail.map_or(Value::Null, |(id, text)| {
            let mut detail = Map::new();
            detail.insert("id".into(), Value::String(id.into()));
            detail.insert("text".into(), Value::String(text.into()));
            Value::Object(detail)
        }),
    );
    let effect = if metadata.kind == "relic" {
        let mut effect = Map::new();
        effect.insert("id".into(), Value::String("minor-ward".into()));
        effect.insert("temporary_hp".into(), Value::from(1));
        Value::Object(effect)
    } else {
        Value::Null
    };
    object.insert("effect".into(), effect);
    Some(Value::Object(object))
}

/// Находка в объекте (`sceneObjectLoot({ mapSeed, prop })`): первая вещь
/// добычи `generic`/`easy`, привязанная к пропу, с происхождением `found`.
pub fn scene_object_loot(map_seed: &str, prop: Option<&Value>) -> Result<Vec<Value>, String> {
    let encounter_id = format!("scene:{}:{}:{}", clean(map_seed, 160), clean_value(field(prop, "id"), 160), clean_value(field(prop, "assetId"), 160));
    let options = serde_json::json!({ "theme": "generic", "difficulty": "easy", "encounterId": encounter_id });
    let loot = sk_items::loot_tables::server_encounter_loot(Some(&options))?;
    let Some(Value::Object(item)) = loot.into_iter().next() else { return Ok(Vec::new()) };
    let mut item = item;
    item.insert("id".into(), Value::String(format!("scene-loot-{}-1", clean_value(field(prop, "id"), 80))));
    let quantity = js::number(item.get("quantity"));
    let quantity = if quantity.is_nan() || quantity == 0.0 { 1.0 } else { quantity };
    item.insert("quantity".into(), js::num(quantity.max(1.0)));
    item.insert("equipped".into(), Value::Bool(false));
    item.insert("origin".into(), Value::String("found".into()));
    Ok(vec![Value::Object(item)])
}

/// Операция над объектом из свободного текста (`sceneObjectOperationFromText`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SceneObjectOperation {
    /// `pray`, `lockpick`, `take`, `use`, `open` или `inspect`.
    pub intent: &'static str,
    /// `force` — ломают; `hand` — всё остальное.
    pub approach: &'static str,
    /// Названные предметы (синонимы каталога).
    pub aliases: Vec<&'static str>,
    /// Названа цель, которая не предмет обстановки (дверь, рычаг, люк).
    pub names_other_target: bool,
}

impl SceneObjectOperation {
    /// Форма JS: `{ intent, approach, aliases, namesOtherTarget? }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("intent".into(), Value::String(self.intent.into()));
        object.insert("approach".into(), Value::String(self.approach.into()));
        object.insert("aliases".into(), js::strings_value(self.aliases.iter().copied()));
        if self.names_other_target {
            object.insert("namesOtherTarget".into(), Value::Bool(true));
        }
        Value::Object(object)
    }
}

/// Цель, которая названа, но предметом обстановки не является.
const NON_PROP_TARGET: &str = r"(?<![а-яё])(?:двер(?:ь|и|ью|ей|ям|ях|ями)|ворот(?:а|ам|ами|ах)?|калитк[аиуеой]|рычаг(?:а|у|ом|е|и|ов)?|люк(?:а|у|ом|е|и)?|окн(?:о|а|у|е|ом)|окош[а-яё]*|ставн[а-яё]*|решётк[а-яё]*|решетк[а-яё]*|шлюз[а-яё]*|засов[а-яё]*|механизм[а-яё]*|лестниц[а-яё]*|мост(?:а|у|ом|е)?|стен(?:а|у|е|ы|ой)|арк(?:а|у|е|ой|и)|проход(?:а|у|ом|е)?)(?![а-яё])";

/// `sceneObjectOperationFromText(text)`.
pub fn scene_object_operation_from_text(text_value: Option<&Value>) -> Option<SceneObjectOperation> {
    let normalized = text::lower(&clean_value(text_value, 1_000));
    if normalized.is_empty() {
        return None;
    }
    let lockpick = text::test(
        re!(r"(?<![а-яё])(?:отмычк|(?:вскры|взлома|слома)[а-яё]*\s+замок|(?:по)?ковыр[а-яё]*\s+(?:в\s+)?замк|подобра[а-яё]*\s+ключ)", "u"),
        &normalized,
    );
    let intent = if text::test(re!(r"(?<![а-яё])(?:помолит|помолюсь|молит[ьв]|молюсь|вознес.{0,3} молитв|преклонить колен)", "u"), &normalized) {
        "pray"
    } else if lockpick {
        "lockpick"
    } else if text::test(re!(r"(?<![а-яё])(?:взять|забрать|поднять|обыскать)", "u"), &normalized) {
        "take"
    } else if text::test(re!(r"(?<![а-яё])(?:использовать|активировать|отдохнуть|привал)", "u"), &normalized) {
        "use"
    } else if text::test(re!(r"(?<![а-яё])(?:открыть|разбить|сломать|взломать|выломать)", "u"), &normalized) {
        "open"
    } else if text::test(re!(r"(?<![а-яё])(?:осмотреть|изучить|прочитать|проверить|обыскать)", "u"), &normalized) {
        "inspect"
    } else {
        return None;
    };
    let approach = if !lockpick && text::test(re!(r"(?:разбить|сломать|взломать|выломать|ударить|топор)", "u"), &normalized) { "force" } else { "hand" };
    let aliases: Vec<&'static str> =
        ASSET_ALIASES_RU.iter().filter(|(_, words)| words.iter().any(|word| normalized.contains(word))).map(|(alias, _)| *alias).collect();
    let names_other_target = aliases.is_empty() && text::test(re!(NON_PROP_TARGET, "u"), &normalized);
    Some(SceneObjectOperation { intent, approach, aliases, names_other_target })
}

/// `Number.isSafeInteger(number)`.
fn is_safe_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
}

/// `propCells(prop)`: клетки площади или клетка центра.
fn prop_cells(prop: Option<&Value>) -> Vec<(f64, f64)> {
    if let Some(Value::Array(footprint)) = field(prop, "footprint") {
        if !footprint.is_empty() {
            return footprint
                .iter()
                .map(|cell| (js::number(field(Some(cell), "x")), js::number(field(Some(cell), "y"))))
                .filter(|(x, y)| x.is_finite() && y.is_finite())
                .collect();
        }
    }
    let x = js::number(field(prop, "x")).floor();
    let y = js::number(field(prop, "y")).floor();
    if x.is_finite() && y.is_finite() {
        vec![(x, y)]
    } else {
        Vec::new()
    }
}

/// `sceneObjectDistance(prop, actorPosition)`: расстояние Чебышёва до
/// ближайшей клетки пропа; `+∞`, если позиция не целая или клеток нет.
pub fn scene_object_distance(prop: Option<&Value>, actor_position: Option<&Value>) -> f64 {
    let x = js::number(field(actor_position, "x"));
    let y = js::number(field(actor_position, "y"));
    if !is_safe_integer(x) || !is_safe_integer(y) {
        return f64::INFINITY;
    }
    prop_cells(prop).into_iter().map(|(cx, cy)| (cx - x).abs().max((cy - y).abs())).fold(f64::INFINITY, f64::min)
}

/// `nearestSceneObjectCommand({ props, actorPosition, text })`: команда
/// `OperateSceneObject` к ближайшему подходящему пропу или `None`.
pub fn nearest_scene_object_command(props: Option<&Value>, actor_position: Option<&Value>, text_value: Option<&Value>) -> Option<Value> {
    let operation = scene_object_operation_from_text(text_value)?;
    if operation.names_other_target && operation.intent != "pray" {
        return None;
    }
    let props: &[Value] = match props {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let mut candidates: Vec<(&Value, f64)> = props
        .iter()
        .filter_map(|prop| {
            let asset_id = js::s(field(Some(prop), "assetId"));
            let entry = catalog_record(&asset_id)?;
            if operation.intent == "pray" && !is_shrine_str(&asset_id) {
                return None;
            }
            if operation.intent == "lockpick" && entry.kind != "container" {
                return None;
            }
            if operation.intent != "pray" && !entry.verbs.contains(&operation.intent) {
                return None;
            }
            if !operation.aliases.is_empty() && !asset_alias(&asset_id).is_some_and(|alias| operation.aliases.contains(&alias)) {
                return None;
            }
            Some((prop, scene_object_distance(Some(prop), actor_position)))
        })
        .filter(|(_, distance)| !operation.aliases.is_empty() || operation.intent == "pray" || *distance <= 1.0)
        .collect();
    candidates.sort_by(|left, right| {
        let by_distance = if left.1 == right.1 { None } else { left.1.partial_cmp(&right.1) };
        by_distance.unwrap_or_else(|| {
            text::locale_compare(&clean_value(field(Some(left.0), "id"), 160), &clean_value(field(Some(right.0), "id"), 160))
        })
    });
    let (selected, _) = candidates.first()?;
    let mut command = Map::new();
    command.insert("command_type".into(), Value::String("OperateSceneObject".into()));
    command.insert("prop_id".into(), Value::String(clean_value(field(Some(selected), "id"), 120)));
    command.insert("intent".into(), Value::String(operation.intent.into()));
    command.insert("approach".into(), Value::String(operation.approach.into()));
    Some(Value::Object(command))
}

fn event_type(event: &Value) -> String {
    js::s(field(Some(event), "event_type"))
}

fn payload<'a>(event: &'a Value, key: &str) -> Option<&'a Value> {
    field(field(Some(event), "payload"), key)
}

fn loot_names(event: &Value) -> Vec<String> {
    match payload(event, "loot") {
        Some(Value::Array(items)) => items.iter().map(|item| clean_value(field(Some(item), "name"), 120)).filter(|name| !name.is_empty()).collect(),
        _ => Vec::new(),
    }
}

/// `sceneInteractionNarration(events)`: короткий рассказ о взаимодействии с
/// объектом сцены; пустая строка — событий объекта в пачке нет.
pub fn scene_interaction_narration(events: Option<&Value>) -> String {
    let batch: &[Value] = match events {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let relevant: Vec<&Value> = batch
        .iter()
        .filter(|event| {
            let kind = event_type(event);
            let typed = field(Some(event), "event_type").and_then(Value::as_str);
            kind.starts_with("SceneObject")
                || (typed == Some("RestCompleted") && js::truthy(payload(event, "source_prop_id")))
                || typed == Some("LockpickNoticed")
                || (typed == Some("DamageApplied") && payload(event, "reason").and_then(Value::as_str) == Some("scene-object-trap"))
        })
        .collect();
    if relevant.is_empty() {
        return String::new();
    }
    let typed = |event: &Value, name: &str| field(Some(event), "event_type").and_then(Value::as_str) == Some(name);
    if let Some(noticed) = relevant.iter().find(|event| typed(event, "LockpickNoticed")) {
        return if payload(noticed, "reason").and_then(Value::as_str) == Some("trace") {
            "Замок вскрыт тихо, но сорванная дужка бросается в глаза: на неё уже смотрят.".into()
        } else if payload(noticed, "severity").and_then(Value::as_str) == Some("major") {
            "Отмычка срывается с громким лязгом — в сцене оборачиваются на звук.".into()
        } else {
            "Замок не поддаётся и предательски звякает: возню у него слышали.".into()
        };
    }
    if let Some(knowledge) = relevant.iter().find(|event| typed(event, "SceneObjectKnowledgeRevealed")) {
        if js::truthy(payload(knowledge, "text")) {
            return clean_value(payload(knowledge, "text"), 500);
        }
    }
    if let Some(loot) = relevant.iter().find(|event| typed(event, "SceneObjectLootGranted")) {
        let names = loot_names(loot);
        return if names.is_empty() { "Находка забрана.".into() } else { format!("Находка забрана: {}.", names.join(", ")) };
    }
    if let Some(trap) =
        relevant.iter().find(|event| typed(event, "DamageApplied") && payload(event, "reason").and_then(Value::as_str) == Some("scene-object-trap"))
    {
        let amount = js::number(payload(trap, "applied_amount"));
        let amount = if amount.is_nan() { 0.0 } else { amount };
        return format!("Сработала ловушка: {} урона.", js::f64_string(amount.max(0.0)));
    }
    if let Some(revealed) = relevant.iter().find(|event| typed(event, "SceneObjectLootRevealed")) {
        let names = loot_names(revealed);
        return if names.is_empty() { "Внутри обнаружена находка.".into() } else { format!("Внутри обнаружено: {}.", names.join(", ")) };
    }
    if relevant.iter().any(|event| typed(event, "RestCompleted") && js::truthy(payload(event, "source_prop_id"))) {
        return "У костра завершён короткий привал.".into();
    }
    let state = relevant.iter().rev().find(|event| typed(event, "SceneObjectStateChanged"));
    if let Some(state) = state {
        let intent_lockpick = payload(state, "intent").and_then(Value::as_str) == Some("lockpick");
        if js::is_false(payload(state, "success")) {
            return if intent_lockpick { "Замок не поддался отмычке.".into() } else { "Попытка не удалась; состояние объекта не изменилось.".into() };
        }
        match payload(state, "state").and_then(Value::as_str) {
            Some("open") => {
                return if intent_lockpick { "Замок поддался отмычке, крышка откинута.".into() } else { "Объект открыт.".into() };
            }
            Some("taken") => return "Содержимое объекта забрано.".into(),
            Some("used") => return "Эффект объекта использован.".into(),
            _ => {}
        }
    }
    if let Some(inspected) = relevant.iter().find(|event| typed(event, "SceneObjectInspected")) {
        return if js::is_false(payload(inspected, "success")) { "Осмотр не дал уверенного ответа.".into() } else { "Объект осмотрен.".into() };
    }
    "Взаимодействие с объектом завершено.".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alias_boundaries_follow_regex() {
        assert!(alias_matches("table", "table"));
        assert!(alias_matches("props/table_small.png", "table"));
        assert!(!alias_matches("tables", "table"));
        assert!(!alias_matches("stable", "table"));
        assert!(alias_matches("a-stable-table", "table"));
        assert_eq!(asset_alias("bar_shelf"), Some("bar_shelf"));
        assert_eq!(asset_alias("Barrel_Stack"), Some("barrel"));
    }
}

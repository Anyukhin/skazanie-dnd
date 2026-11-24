//! Перенос `server/llm-json-schemas.mjs`: JSON Schema ответов JSON-ролей
//! модели для `response_format: json_schema` (strict).
//!
//! Схема — дополнительная гарантия формы на стороне провайдера, а не замена
//! проверки: ответ по-прежнему проходит валидатор роли
//! (`normalize_director_intent` и др.). В strict-режиме каждое свойство
//! перечислено в `required`, лишние запрещены (`additionalProperties: false`),
//! необязательное поле присутствует, но может быть `null`; `pattern`,
//! `minimum`/`maximum` и `anyOf` не используются.
//!
//! Схемы — тот же JSON, что у JS, байт в байт по `js::stringify` (порядок
//! ключей — порядок литералов JS).

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_encounters::encounter_assembler::{ENCOUNTER_DIFFICULTIES, ENCOUNTER_THEMES};
use sk_world_story::autonomous_campaign::DIRECTOR_INTENT_TYPES;

/// Способы `resolve_scene` — копия allowlist валидатора.
pub const DIRECTOR_SCENE_RESOLUTIONS: [&str; 3] = ["negotiation", "objective", "decision"];

/// Отношение NPC — allowlist `npc-social-controller.mjs`.
pub const NPC_SOCIAL_STANCES: [&str; 4] = ["friendly", "neutral", "guarded", "hostile"];

/// Направление обещания NPC.
pub const NPC_PROMISE_DIRECTIONS: [&str; 2] = ["npc_to_party", "party_to_npc"];

/// `nullable(schema)`: `{ ...schema, type: [schema.type, 'null'] }`.
fn nullable(schema: Value) -> Value {
    let mut map = match schema {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let kind = map.get("type").cloned().unwrap_or(Value::Null);
    map.insert("type".into(), json!([kind, "null"]));
    Value::Object(map)
}

/// `nullableEnum(values)`: строка из списка или `null`.
fn nullable_enum(values: &[&str]) -> Value {
    let mut list: Vec<Value> = values.iter().map(|value| json!(value)).collect();
    list.push(Value::Null);
    json!({ "type": ["string", "null"], "enum": list })
}

fn text() -> Value {
    json!({ "type": "string" })
}

fn string_enum(values: &[&str]) -> Value {
    json!({ "type": "string", "enum": values })
}

fn number() -> Value {
    json!({ "type": "number" })
}

fn integer() -> Value {
    json!({ "type": "integer" })
}

fn boolean() -> Value {
    json!({ "type": "boolean" })
}

fn array_of(items: Value) -> Value {
    json!({ "type": "array", "items": items })
}

/// `strictObject(properties)`: все свойства обязательны, лишние запрещены.
fn strict_object(properties: Vec<(&str, Value)>) -> Value {
    let required: Vec<Value> = properties.iter().map(|(key, _)| json!(key)).collect();
    let mut props = Map::new();
    for (key, value) in properties {
        props.insert(key.into(), value);
    }
    let mut map = Map::new();
    map.insert("type".into(), json!("object"));
    map.insert("additionalProperties".into(), json!(false));
    map.insert("required".into(), Value::Array(required));
    map.insert("properties".into(), Value::Object(props));
    Value::Object(map)
}

fn named(name: &str, schema: Value) -> Value {
    json!({ "name": name, "strict": true, "schema": schema })
}

const DANGERS: [&str; 3] = ["низкая", "средняя", "высокая"];
const SCENE_LANDMARK_KINDS: [&str; 30] = [
    "shelter", "platform", "threshold_stone", "crate", "chest", "campfire", "hearth", "well", "statue", "altar",
    "shrine", "cart", "market_stall", "haystack", "trough", "fence", "barrels", "signpost", "milestone", "lantern",
    "grave", "table", "bench", "brazier", "cauldron", "oak", "notice_board", "forge", "mooring", "rowboat",
];
const LANDMARK_ROLES: [&str; 5] = ["focus", "npc_post", "clue", "entry", "dressing"];
const SHOP_SETTLEMENT_TYPES: [&str; 5] = ["village", "town", "city", "outpost", "traveling"];
const SHOP_THEMES: [&str; 4] = ["general", "provisions", "arms", "healing"];
const GM_SECRET_SKILLS: [&str; 9] = ["investigation", "perception", "survival", "insight", "history", "arcana", "religion", "nature", "medicine"];
const FREE_ACTION_ACTIVITY_KINDS: [&str; 6] = ["routine", "stunt", "environmental", "stealth", "social", "knowledge"];
const FREE_ACTION_DURATION_CLASSES: [&str; 5] = ["instant", "brief", "minutes", "extended", "prolonged"];
const FREE_ACTION_SKILLS: [&str; 18] = [
    "acrobatics", "animal-handling", "arcana", "athletics", "deception", "history", "insight", "intimidation", "investigation",
    "medicine", "nature", "perception", "performance", "persuasion", "religion", "sleight-of-hand", "stealth", "survival",
];
const PLAUSIBILITY_LEVELS: [&str; 4] = ["trivial", "plausible", "strenuous", "impossible_without_means"];
const RISK_LEVELS: [&str; 4] = ["none", "minor", "serious", "deadly"];
const FREE_ACTION_PROFICIENCY_LEVELS: [&str; 3] = ["none", "proficient", "expertise"];
const FREE_ACTION_CONSEQUENCE_TYPES: [&str; 5] = ["time", "noise", "exposure", "lost_opportunity", "injury"];
const IMPROVISED_EFFECT_IDS: [&str; 9] = ["none", "prone", "help_ally", "distract", "blind", "restrain", "hazard_damage", "topple_prop", "ignite_prop"];

/// DirectorIntent: поля валидатора без `version`, механических полей нет.
pub static DIRECTOR_INTENT_JSON_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    named(
        "director_intent",
        strict_object(vec![
            ("type", string_enum(&DIRECTOR_INTENT_TYPES)),
            ("theme", nullable_enum(&ENCOUNTER_THEMES)),
            ("difficulty", nullable_enum(&ENCOUNTER_DIFFICULTIES)),
            ("quest_id", nullable(text())),
            ("npc_id", nullable(text())),
            ("hook", nullable(text())),
            ("destination", nullable(text())),
            ("resolution", nullable_enum(&DIRECTOR_SCENE_RESOLUTIONS)),
            ("reason", nullable(text())),
        ]),
    )
});

/// Ответ NPC в социальной сцене; `promise` — объект или `null`.
pub static NPC_SOCIAL_RESPONSE_JSON_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    named(
        "npc_social_response",
        strict_object(vec![
            ("npc_id", text()),
            ("reply", text()),
            ("stance", string_enum(&NPC_SOCIAL_STANCES)),
            ("disclosed_fact_ids", array_of(text())),
            ("disclosed_claim_ids", array_of(text())),
            ("relationship_delta", number()),
            (
                "promise",
                json!({
                    "type": ["object", "null"],
                    "additionalProperties": false,
                    "required": ["direction", "text", "due_hint"],
                    "properties": {
                        "direction": string_enum(&NPC_PROMISE_DIRECTIONS),
                        "text": text(),
                        "due_hint": text(),
                    },
                }),
            ),
            ("confidence", number()),
        ]),
    )
});

/// Создание кампании (`prompts/campaign_creator`): перечисления — из формата
/// промпта, совпадают с allowlist `normalizeOpening`.
pub static CAMPAIGN_CREATION_JSON_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    let world_map = strict_object(vec![
        ("name", text()),
        (
            "regions",
            array_of(strict_object(vec![
                ("name", text()),
                ("biome", string_enum(&["plains", "forest", "mountains", "marsh", "desert", "tundra", "coast", "wastes"])),
                ("x", number()),
                ("y", number()),
                ("radius", number()),
            ])),
        ),
        (
            "locations",
            array_of(strict_object(vec![
                ("name", text()),
                ("kind", string_enum(&["capital", "city", "town", "village", "port", "fortress", "ruin", "dungeon", "landmark", "wilds"])),
                ("region", text()),
                ("x", number()),
                ("y", number()),
                ("summary", text()),
                ("known", boolean()),
                ("visited", boolean()),
            ])),
        ),
        (
            "routes",
            array_of(strict_object(vec![
                ("from", text()),
                ("to", text()),
                ("kind", string_enum(&["road", "trail", "river", "sea", "pass"])),
                ("distance", number()),
                ("danger", string_enum(&DANGERS)),
                ("discovered", boolean()),
            ])),
        ),
    ]);
    let map = strict_object(vec![
        ("layout", string_enum(&["rooms", "streets", "open", "winding", "cavern", "ruins", "radial"])),
        ("scale", string_enum(&["room", "site", "stronghold", "region"])),
        ("pattern", string_enum(&["small-room", "great-hall", "keep", "courtyard", "crypt", "cave-cluster", "village", "bridge", "natural"])),
        ("material", string_enum(&["stone", "wood", "earth", "grass", "sand", "metal", "marble", "ice"])),
        ("width", integer()),
        ("height", integer()),
        ("openness", number()),
        ("water", number()),
        ("featureCount", integer()),
        (
            "design",
            strict_object(vec![
                ("topology", string_enum(&["organic", "linear", "crossroads", "market", "courtyard", "harbor", "river", "terraced", "gate"])),
                ("climate", string_enum(&["temperate", "arid", "cold", "wetland"])),
                ("architecture", string_enum(&["wood", "stone", "sand", "metal", "marble", "ice"])),
                ("density", string_enum(&["sparse", "mixed", "dense"])),
                ("building_use", string_enum(&["dwelling", "tavern", "shop", "manor"])),
                    (
                        "landmarks",
                        array_of(strict_object(vec![
                            ("kind", string_enum(&SCENE_LANDMARK_KINDS)),
                            ("role", string_enum(&LANDMARK_ROLES)),
                            ("count", integer()),
                            ("npc", nullable(text())),
                        ])),
                    ),
            ]),
        ),
    ]);
    named(
        "campaign_creation",
        strict_object(vec![
            ("campaignName", text()),
            ("partyName", text()),
            ("worldSummary", text()),
            ("worldHistory", text()),
            ("worldMap", world_map),
            ("openingNarration", text()),
            (
                "scene",
                strict_object(vec![
                    ("title", text()),
                    ("location", text()),
                    ("mood", text()),
                    ("objective", text()),
                    ("theme", text()),
                    ("danger", string_enum(&DANGERS)),
                    ("map", map),
                ]),
            ),
            (
                "npcs",
                array_of(strict_object(vec![
                    ("name", text()),
                    ("role", text()),
                    ("summary", text()),
                    ("voice", text()),
                    ("goals", array_of(text())),
                    ("beliefs", array_of(text())),
                ])),
            ),
            (
                "secrets",
                array_of(strict_object(vec![
                    ("clue", text()),
                    ("topic", text()),
                    ("skills", array_of(string_enum(&GM_SECRET_SKILLS))),
                    ("holder", text()),
                ])),
            ),
            ("canon", array_of(text())),
            ("hook", text()),
        ]),
    )
});

/// План новой сцены (`prompts/map_architect/v8.txt`).
pub static SCENE_ARCHITECT_JSON_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    let landmarks = strict_object(vec![
        ("kind", string_enum(&SCENE_LANDMARK_KINDS)),
        ("role", string_enum(&LANDMARK_ROLES)),
        ("count", integer()),
        ("npc", nullable(text())),
    ]);
    let design = strict_object(vec![
        ("topology", string_enum(&["organic", "linear", "crossroads", "market", "courtyard", "harbor", "river", "terraced", "gate"])),
        ("climate", string_enum(&["temperate", "arid", "cold", "wetland"])),
        ("architecture", string_enum(&["wood", "stone", "sand", "metal", "marble", "ice"])),
        ("density", string_enum(&["sparse", "mixed", "dense"])),
        ("building_use", string_enum(&["dwelling", "tavern", "shop", "manor", "smithy", "barracks", "mill"])),
        ("landmarks", array_of(landmarks)),
    ]);
    let map = strict_object(vec![
        ("layout", string_enum(&["rooms", "streets", "open", "winding", "cavern", "ruins", "radial"])),
        ("scale", string_enum(&["room", "site", "stronghold", "region"])),
        ("pattern", string_enum(&["small-room", "great-hall", "keep", "courtyard", "crypt", "cave-cluster", "village", "bridge", "natural"])),
        ("material", string_enum(&["stone", "wood", "earth", "grass", "sand", "metal", "marble", "ice"])),
        ("width", integer()),
        ("height", integer()),
        ("openness", number()),
        ("water", number()),
        ("featureCount", integer()),
        ("design", design),
    ]);
    let shop_intent = json!({
        "type": ["object", "null"],
        "additionalProperties": false,
        "required": ["action", "settlement_type", "theme", "budget_cp", "reason"],
        "properties": {
            "action": string_enum(&["create", "none"]),
            "settlement_type": string_enum(&SHOP_SETTLEMENT_TYPES),
            "theme": string_enum(&SHOP_THEMES),
            "budget_cp": integer(),
            "reason": text(),
        },
    });
    named(
        "scene_architect",
        strict_object(vec![
            ("title", text()),
            ("location", text()),
            ("mood", text()),
            ("objective", text()),
            ("transition", text()),
            ("arrival", text()),
            ("hook", text()),
            ("theme", text()),
            ("danger", string_enum(&DANGERS)),
            ("outcome", text()),
            ("objective_status", string_enum(&["completed", "unresolved", "abandoned"])),
            ("carry_unresolved", boolean()),
            ("map", map),
            ("levels", array_of(strict_object(vec![("offset", integer()), ("hint", text())]))),
            ("shop_intent", shop_intent),
            (
                "secrets",
                array_of(strict_object(vec![
                    ("clue", text()),
                    ("topic", text()),
                    ("skills", array_of(string_enum(&GM_SECRET_SKILLS))),
                ])),
            ),
        ]),
    )
});

const ACTION_HAZARDS: [&str; 7] = ["", "fall", "fire", "scalding", "crush", "caustic", "shards"];

/// Разбор свободного действия (`prompts/action_adjudicator/v10.txt`).
pub static ACTION_ADJUDICATOR_JSON_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    named(
        "action_adjudicator",
        strict_object(vec![
            ("route", string_enum(&["check", "travel", "talk", "clarify"])),
            ("destination", text()),
            ("npc_hint", text()),
            ("goal_summary", text()),
            ("approach_summary", text()),
            ("obstacle", text()),
            ("activity_kind", string_enum(&FREE_ACTION_ACTIVITY_KINDS)),
            ("duration_class", string_enum(&FREE_ACTION_DURATION_CLASSES)),
            ("ability", string_enum(&["str", "dex", "con", "int", "wis", "cha"])),
            ("skill", string_enum(&FREE_ACTION_SKILLS)),
            ("plausibility", string_enum(&PLAUSIBILITY_LEVELS)),
            ("risk", string_enum(&RISK_LEVELS)),
            ("required_means", array_of(text())),
            ("action_cost", string_enum(&["action", "bonus_action", "free"])),
            ("effect", string_enum(&IMPROVISED_EFFECT_IDS)),
            ("effect_target", text()),
            ("hazard", string_enum(&ACTION_HAZARDS)),
            ("prop_id", text()),
            ("target_id", text()),
            ("item_id", text()),
            ("proficiency", string_enum(&FREE_ACTION_PROFICIENCY_LEVELS)),
            ("consequence_type", string_enum(&FREE_ACTION_CONSEQUENCE_TYPES)),
            ("success_detail", text()),
            ("surface_detail", text()),
            ("failure_detail", text()),
        ]),
    )
});

/// Зацепки из предысторий героев (`prompts/hero_hooks`). Пустой `holder` —
/// хранителя нет.
pub static HERO_HOOKS_JSON_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    named(
        "hero_hooks",
        strict_object(vec![(
            "heroes",
            array_of(strict_object(vec![
                ("hero_id", text()),
                ("motive", text()),
                (
                    "hooks",
                    array_of(strict_object(vec![("topic", text()), ("clue", text()), ("skills", array_of(text())), ("holder", text())])),
                ),
            ])),
        )]),
    )
});

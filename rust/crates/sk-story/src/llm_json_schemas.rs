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
            ("hook", text()),
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

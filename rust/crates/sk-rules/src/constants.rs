//! Константы и версии `rules-engine.mjs`, нужные нескольким задачам. Задача Р0.
//!
//! JS: 583–667 (версии проектора и редьюсера, маркеры), 949–977 (отдых),
//! 1102, 1111 (призывы и путь хода), 1873–1888 («Готовность», пламя),
//! 2719, 4352–4527 (таблица состояний и производные наборы), 9615–9617,
//! 12711–12718 (подписи предпочтений реакций). Маркеры контекста на `Symbol`
//! (586–599) — поля [`crate::context::Context`].

pub use crate::turn_economy::{ACTION_ECONOMY_EVENT_VERSION, ATTACK_ACTION_KINDS, LOADING_ACTION_TYPES};

/// `MAGIC_ITEM_SPELL_IMMUNITY_EVENT_SCHEMA_VERSION`.
pub const MAGIC_ITEM_SPELL_IMMUNITY_EVENT_SCHEMA_VERSION: i64 = 1;
/// Безоружные удары монаха бонусным действием (`MONK_BONUS_UNARMED_ACTION_IDS`).
pub const MONK_BONUS_UNARMED_ACTION_IDS: [&str; 3] = ["martial-arts-strike", "flurry-of-blows", "monk-put-otkrytoy-ladoni-tehniki-otkrytoy-ladoni"];
/// Версия проектора состояния (`GAME_STATE_PROJECTOR_VERSION`): бамп
/// отбрасывает снимки и заставляет переиграть журнал целиком.
pub const GAME_STATE_PROJECTOR_VERSION: i64 = 19;
/// `GAME_REDUCER_VERSION` = `RETENTION_REDUCER_VERSION`.
pub const GAME_REDUCER_VERSION: i64 = sk_society::retention_context::RETENTION_REDUCER_VERSION;
/// Сколько раз один ход может начать отсчёт заново из-за окна реакции.
pub const TURN_REACTION_EXTENSION_LIMIT: i64 = 2;
/// На сколько падает отношение у того, кого поймали за руку в своём кармане.
pub const PICKPOCKET_CAUGHT_RELATIONSHIP_DELTA: i64 = -12;

/// `REST_POLICY_ID`.
pub const REST_POLICY_ID: &str = "srd-5.2.1-rest-v2";
/// `REST_EVENT_SCHEMA_VERSION`.
pub const REST_EVENT_SCHEMA_VERSION: i64 = 2;
/// `HIT_POINT_DIE_EVENT_SCHEMA_VERSION`.
pub const HIT_POINT_DIE_EVENT_SCHEMA_VERSION: i64 = 1;
/// `AMMUNITION_SPENT_EVENT_SCHEMA_VERSION`: абсолютные остатки в payload.
pub const AMMUNITION_SPENT_EVENT_SCHEMA_VERSION: i64 = 1;
/// `REST_MINIMUM_MINUTES.short`.
pub const REST_MINIMUM_MINUTES_SHORT: i64 = 60;
/// `REST_MINIMUM_MINUTES.long`.
pub const REST_MINIMUM_MINUTES_LONG: i64 = 480;
/// Кость хитов класса (`CLASS_HIT_POINT_DIE_SIZES`), в порядке JS.
pub const CLASS_HIT_POINT_DIE_SIZES: [(&str, i64); 12] = [
    ("barbarian", 12),
    ("fighter", 10),
    ("paladin", 10),
    ("ranger", 10),
    ("bard", 8),
    ("cleric", 8),
    ("druid", 8),
    ("monk", 8),
    ("rogue", 8),
    ("warlock", 8),
    ("sorcerer", 6),
    ("wizard", 6),
];

/// `CLASS_HIT_POINT_DIE_SIZES[classKey]`.
pub fn class_hit_point_die_size(class_key: &str) -> Option<i64> {
    CLASS_HIT_POINT_DIE_SIZES.iter().find(|(key, _)| *key == class_key).map(|(_, size)| *size)
}

/// `SUMMON_LIFECYCLE_VERSION`.
pub const SUMMON_LIFECYCLE_VERSION: i64 = 2;
/// `MOVE_BATTLE_LOG_PATH_VERSION`: с этой версии `ActorMoved` несёт путь шага в журнал.
pub const MOVE_BATTLE_LOG_PATH_VERSION: i64 = 1;

/// Что гасит «Потушить пламя» (`EXTINGUISHABLE_FLAME_CONDITIONS`).
pub const EXTINGUISHABLE_FLAME_CONDITIONS: [&str; 2] = ["searing-smite-flames", "alchemists-fire-flames"];
/// Триггеры «Готовности», которые сервер распознаёт (`READIED_TRIGGERS`).
pub const READIED_TRIGGERS: [(&str, &str); 2] = [("enemy-approaches", "враг подойдёт вплотную"), ("enemy-casts-spell", "враг начнёт творить заклинание")];
/// Существа среди сущностей `SpawnEntity` (`CREATURE_ENTITY_KINDS`).
pub const CREATURE_ENTITY_KINDS: [&str; 1] = ["enemy"];

/// `ALL_ABILITIES`.
pub const ALL_ABILITIES: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];
/// `PROTECTION_FROM_ENERGY_EXPIRY_POLICY`.
pub const PROTECTION_FROM_ENERGY_EXPIRY_POLICY: &str = "protection-from-energy/v1";
/// Булевы состояния с отдельным экземпляром на каждый источник
/// (`SOURCE_SCOPED_BOOLEAN_CONDITIONS`).
pub const SOURCE_SCOPED_BOOLEAN_CONDITIONS: [&str; 16] = [
    "blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated", "invisible", "banished", "paralyzed", "petrified", "poisoned", "prone", "restrained",
    "stunned", "surprised", "unconscious",
];

/// Острое словцо барда Знаний (`CUTTING_WORDS_ACTION_ID`).
pub const CUTTING_WORDS_ACTION_ID: &str = "bard-kollegiya-znaniy-ostroe-slovtso";
/// Боевой стиль «Оборона» (`PROTECTION_ACTION_IDS`).
pub const PROTECTION_ACTION_IDS: [&str; 2] = ["fighter-zaschita", "paladin-zaschita"];

/// Подписи реакций с режимом (`REACTION_PREFERENCE_LABELS`), в порядке JS.
pub const REACTION_PREFERENCE_LABELS: [(&str, &str); 12] = [
    ("opportunity-attack", "Атака по возможности"),
    ("cast:counterspell", "Контрзаклинание"),
    ("cast:shield", "Щит"),
    ("cast:absorb-elements", "Поглощение стихий"),
    ("cast:hellish-rebuke", "Адское возмездие"),
    ("cast:silvery-barbs", "Искусная острота"),
    ("uncanny-dodge", "Невероятное уклонение"),
    ("parry", "Парирование"),
    ("riposte", "Ответный удар"),
    (CUTTING_WORDS_ACTION_ID, "Острое словцо"),
    ("fighter-zaschita", "Оборона"),
    ("paladin-zaschita", "Оборона"),
];
/// `REACTION_PREFERENCE_SPELL_IDS`.
pub const REACTION_PREFERENCE_SPELL_IDS: [&str; 5] = ["counterspell", "shield", "absorb-elements", "hellish-rebuke", "silvery-barbs"];
/// `REACTION_PREFERENCE_ACTION_IDS`.
pub const REACTION_PREFERENCE_ACTION_IDS: [&str; 6] = ["uncanny-dodge", "parry", "riposte", CUTTING_WORDS_ACTION_ID, "fighter-zaschita", "paladin-zaschita"];

/// `REACTION_PREFERENCE_LABELS[id]`.
pub fn reaction_preference_label(id: &str) -> Option<&'static str> {
    REACTION_PREFERENCE_LABELS.iter().find(|(key, _)| *key == id).map(|(_, label)| *label)
}

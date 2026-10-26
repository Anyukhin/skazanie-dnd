//! Перенос `server/world-ontology.mjs`: онтология памяти мира — какие
//! предикаты фактов и отношения между сущностями существуют, кто их пишет и
//! кто читает.
//!
//! Модуль — реестр словаря, статический сканер исходников и проверка записи.
//! Он детерминирован, ничего не импортирует и не читает файлов: тексты
//! сканеру передают тест и аудит; проверку записи `ontology_violation`
//! вызывает `validate_world_memory_command` (`sk-memory`) для каждой команды
//! факта, убеждения и слуха (#189). Редьюсер её не вызывает: уже записанные
//! события читаются при replay как есть, даже если их предиката в словаре
//! больше нет.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Serialize;
use serde_json::{json, Map, Value};
use sk_core::fancy_regex::Regex;
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{re, text};

use crate::common::utf16_cmp;

/// Запись словаря предикатов (`PredicateEntry`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PredicateEntry {
    /// `fact` или `claim`.
    pub record: &'static str,
    /// Семейство с суффиксом (`party_deed:<kind>`).
    pub family: bool,
    pub subject_kinds: &'static [&'static str],
    pub object: &'static str,
    pub producers: &'static [&'static str],
    pub consumers: &'static [&'static str],
    pub external_producers: Option<&'static [&'static str]>,
    /// Конкретного читателя нет сознательно: предикат читают только общие
    /// читатели (`GENERIC_PREDICATE_CONSUMERS`).
    pub generic_readers_only: bool,
    /// `public`, `party`, `gm_only` или `mixed`.
    pub visibility: &'static str,
    pub description_ru: &'static str,
}

impl PredicateEntry {
    /// Запись в форме JS (`family` и `external_producers` — только когда заданы).
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("record".into(), json!(self.record));
        if self.family {
            map.insert("family".into(), json!(true));
        }
        map.insert("subject_kinds".into(), json!(self.subject_kinds));
        map.insert("object".into(), json!(self.object));
        map.insert("producers".into(), json!(self.producers));
        map.insert("consumers".into(), json!(self.consumers));
        if let Some(external) = self.external_producers {
            map.insert("external_producers".into(), json!(external));
        }
        if self.generic_readers_only {
            map.insert("generic_readers_only".into(), json!(true));
        }
        map.insert("visibility".into(), json!(self.visibility));
        map.insert("description_ru".into(), json!(self.description_ru));
        Value::Object(map)
    }
}

/// Запись словаря отношений (`RelationEntry`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RelationEntry {
    pub from_kinds: &'static [&'static str],
    pub to_kinds: &'static [&'static str],
    pub producers: &'static [&'static str],
    pub consumers: &'static [&'static str],
    pub external_producers: Option<&'static [&'static str]>,
    pub visibility: &'static str,
    pub description_ru: &'static str,
}

/// Предикаты. Ключ с двоеточием на конце — семейство (`party_deed:<kind>`).
/// `producers`/`consumers` — имена модулей `server/` без расширения, ровно те,
/// что находит сканер.
pub static PREDICATES: &[(&str, PredicateEntry)] = &[
    (
        "died",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc"],
            object: "id локации, где NPC погиб",
            producers: &["npc-positioning"],
            consumers: &["game-orchestrator", "npc-positioning", "quest-consequences"],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "NPC погиб. Делает поручение невозможным, убирает NPC из сцен, попадает в список известных мёртвых Рассказчика.",
        },
    ),
    (
        "discovery",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc", "faction", "location", "item", "event", "concept"],
            object: "«clue»",
            producers: &["world-memory"],
            consumers: &["campaign-dialogues", "campaign-scenario", "game-orchestrator", "narrator", "npc-social", "npc-social-controller", "player-request-router", "rules-engine", "scenario-knight", "world-memory"],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Находка свободного действия: открытая заготовка ведущего, знающий собеседник или улика по теме активного поручения. Рассказчик обязан её назвать; для часов поручения — доказательство; для сценария — найденная улика узла сюжета (по `supersedes_fact_id`). NPC знает находку, только если видел её сам (граница знания `npcKnownFactIds`); находку о себе самом NPC не знает. Собеседнику уходят и последние находки отряда (`table_knows`) — чтобы он не пересказывал их как новость.",
        },
    ),
    (
        "quest_progress",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc", "faction", "location", "item", "event", "concept"],
            object: "что именно продвинуло дело",
            producers: &[],
            consumers: &["world-memory"],
            external_producers: Some(&["admin_command"]),
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Продвижение поручения, записанное ведущим через административную команду `RecordWorldFact`. Ни один модуль сервера его не пишет.",
        },
    ),
    (
        "lore",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc", "faction", "location", "item", "event", "concept"],
            object: "что правда о сущности",
            producers: &[],
            consumers: &[],
            external_producers: Some(&["admin_command"]),
            generic_readers_only: true,
            visibility: "mixed",
            description_ru: "Правда о мире, записанная ведущим через `RecordWorldFact`: «брод закрыт после паводка». Механика его не читает — только общие читатели (Рассказчик, Хранитель знаний, поиск по памяти). Предикат для записей, у которых нет механического смысла; механический факт пишется своим предикатом.",
        },
    ),
    (
        "scene_change",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["location"],
            object: "перечень сменившихся обстоятельств сцены",
            producers: &["autonomous-orchestrator"],
            consumers: &["scene-summary"],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Режиссёр сменил сцену; сводка сцены берёт отсюда переход.",
        },
    ),
    (
        "quest_outcome",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc", "faction", "location", "item", "event", "concept"],
            object: "исход поручения (completed/failed/…)",
            producers: &["autonomous-orchestrator"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "mixed",
            description_ru: "Итог поручения, закрытого Режиссёром. Подлежащее — первая сущность поручения, иначе текущая сцена или сущность-развязка. Читается только общими читателями.",
        },
    ),
    (
        "encounter_outcome",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["location"],
            object: "исход встречи",
            producers: &["autonomous-orchestrator"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Итог боевой или социальной встречи. Механика читает `autonomy.encounter_outcomes`, а не этот факт.",
        },
    ),
    (
        "promise_condition",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["location", "concept"],
            object: "JSON { promise_id, condition }",
            producers: &["autonomous-orchestrator"],
            consumers: &["autonomous-orchestrator"],
            external_producers: None,
            generic_readers_only: false,
            visibility: "gm_only",
            description_ru: "Условие, при котором обещание NPC исполняется или нарушается.",
        },
    ),
    (
        "opening_narration",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["location"],
            object: "подтверждённый пролог сцены",
            producers: &["campaign-bootstrap"],
            consumers: &["action-adjudicator", "npc-social", "npc-social-controller", "player-request-router"],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Абзацы пролога кампании; судья свободных действий читает их как описание места, модель собеседника — как фон. Запасной ответ NPC без модели пролог вслух не произносит. Граница знания NPC берёт отсюда место старта отряда.",
        },
    ),
    (
        "scene_canon",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["location"],
            object: "установленный факт исходной ситуации",
            producers: &["campaign-bootstrap"],
            consumers: &["agent-context"],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Канон сцены (campaign_creator/v8): короткие очевидные факты исходной ситуации — что случилось и когда, где что стоит, чьё это, сколько идти. Их знает любой в первой сцене; `sceneCanonFor` отдаёт их рассказчику, собеседнику и судье свободных действий, чтобы мир не переписывался от реплики к реплике.",
        },
    ),
    (
        "gm_secret",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["location"],
            object: "JSON { topic, skills, holder, hero_id? }",
            producers: &["world-memory"],
            consumers: &["campaign-dialogues", "hero-hooks", "npc-social", "npc-social-controller", "world-memory"],
            external_producers: None,
            generic_readers_only: false,
            visibility: "gm_only",
            description_ru: "Заготовка ведущего: то, что уже правда в первой сцене (campaign_creator/v7 или авторский мир), в новой области (map_architect/v7) или в месте сценария (`campaign-scenario`, стабильный id) и скрыто от героев. Факт строит `gmSecretFact`. Удачная проверка подходящего навыка заменяет её фактом отряда discovery; знающий NPC может выдать её в разговоре (хранитель — по `holder`, `known_fact_ids` или, у заготовки места без хранителя, житель места, выбранный `implicitSecretHolderIds`). Зацепки из предысторий героев (`hero-hooks`) — те же заготовки с `hero_id` в JSON `object`; собеседник указывает на их хранителя зацепкой (`conversationLeads`), не раскрывая текста.",
        },
    ),
    (
        "band_camp",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc"],
            object: "id ватаги",
            producers: &["captives"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "gm_only",
            description_ru: "Зацепка пленного: где лагерь ватаги. Раскрывается допросом.",
        },
    ),
    (
        "band_paid",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc"],
            object: "id ватаги",
            producers: &["captives"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "gm_only",
            description_ru: "Зацепка пленного: у налёта был заказчик.",
        },
    ),
    (
        "band_reinforcements",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc"],
            object: "id ватаги",
            producers: &["captives"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "gm_only",
            description_ru: "Зацепка пленного: ватага ждёт подкрепления.",
        },
    ),
    (
        "band_cache",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc"],
            object: "id ватаги",
            producers: &["captives"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "gm_only",
            description_ru: "Зацепка пленного: схрон ватаги.",
        },
    ),
    (
        "courier_letter_delivered",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc"],
            object: "JSON { letter_id, hero_id, at_minutes }",
            producers: &["courier-letters"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Письмо отряда дошло до адресата.",
        },
    ),
    (
        "courier_letter_unanswered",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc"],
            object: "JSON письма",
            producers: &["courier-letters"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Адресат не ответил на письмо.",
        },
    ),
    (
        "courier_letter_answered",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc"],
            object: "JSON ответа",
            producers: &["courier-letters"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Ответ на письмо дошёл до отряда.",
        },
    ),
    (
        "quest_deadline_missed",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["concept"],
            object: "JSON { quest_id, at_minutes }",
            producers: &["offscreen-world"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Срок поручения истёк, пока отряд был занят другим. Подлежащее — служебная сущность offscreen-quest-*, а не сущности самого поручения.",
        },
    ),
    (
        "faction_offscreen_move:",
        PredicateEntry {
            record: "fact",
            family: true,
            subject_kinds: &["faction"],
            object: "JSON хода фракции",
            producers: &["offscreen-world"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Ход фракции за кадром; суффикс — вид хода.",
        },
    ),
    (
        "party_traveled_to",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["location"],
            object: "имя локации назначения (подлежащее — откуда ушли)",
            producers: &["scene-memory"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Отряд вышел к новой локации.",
        },
    ),
    (
        "party_arrived",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["location"],
            object: "текст прибытия",
            producers: &["scene-memory"],
            consumers: &["npc-social"],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Отряд прибыл в локацию. Граница знания NPC по цепочке прибытий выводит, где стоял отряд, когда записан факт.",
        },
    ),
    (
        "blessed_by_priest",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["location"],
            object: "id героя",
            producers: &["rules-engine"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Герой получил благословение жреца; без сущности-локации факт не пишется.",
        },
    ),
    (
        "blessed_at_shrine",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["location"],
            object: "id героя",
            producers: &["rules-engine"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Герой получил благословение у святилища; без сущности-локации факт не пишется.",
        },
    ),
    (
        "spared_by_party",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc"],
            object: "исход пощады (ally/informant/…)",
            producers: &["rules-engine"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "gm_only",
            description_ru: "Отряд пощадил сдавшегося врага.",
        },
    ),
    (
        "handed_to_watch",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc"],
            object: "id поселения",
            producers: &["rules-engine"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Пленный передан страже.",
        },
    ),
    (
        "parley_oath",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["npc"],
            object: "исход переговоров (withdraw/tribute)",
            producers: &["rules-engine"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "party",
            description_ru: "Клятва вожака противника, данная на переговорах.",
        },
    ),
    (
        "party_deed",
        PredicateEntry {
            record: "fact",
            family: false,
            subject_kinds: &["location"],
            object: "JSON поступка",
            producers: &["world-deeds"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "gm_only",
            description_ru: "Поступок отряда в летописи мира. Его разносит молва, а не факт.",
        },
    ),
    (
        "party_deed:",
        PredicateEntry {
            record: "claim",
            family: true,
            subject_kinds: &["npc"],
            object: "пересказ поступка",
            producers: &["world-deeds"],
            consumers: &[],
            external_producers: None,
            generic_readers_only: false,
            visibility: "gm_only",
            description_ru: "Слух о поступке отряда у конкретного NPC (утверждение, не факт); суффикс — вид поступка. Репутацию считает id слуха, а не предикат.",
        },
    ),
];

/// Предикат по имени.
pub fn predicate(name: &str) -> Option<&'static PredicateEntry> {
    PREDICATES.iter().find(|(key, _)| *key == name).map(|(_, entry)| entry)
}

/// Отношения между сущностями. Ни один модуль сервера сейчас их не создаёт:
/// отношения приходят из административных команд, импорта и фикстур.
pub static RELATIONS: &[(&str, RelationEntry)] = &[];

/// Модули, которые читают любой предикат как есть.
pub const GENERIC_PREDICATE_CONSUMERS: [(&str, &str); 5] = [
    ("world-memory", "поиск по памяти: предикат и отношение входят в текст для ранжирования, шаг по графу идёт по любому видимому отношению"),
    ("director-agent", "передаёт предикат факта Режиссёру как есть"),
    ("game-orchestrator", "передаёт предикат факта Рассказчику как есть"),
    ("player-request-router", "Хранитель знаний подставляет предикат, если у факта нет текста"),
    ("campaign-lifecycle", "экспорт и импорт кампании переносят предикат без изменений"),
];

/// Предикаты, у которых нет производителя в коде сознательно: их пишет только ведущий.
pub const EXTERNAL_ONLY_PREDICATES: [&str; 2] = ["lore", "quest_progress"];

/// Статья словаря для предиката записи (`predicateEntryFor`,
/// `server/world-ontology.mjs:277`): точное имя или семейство `prefix:` с
/// непустым суффиксом (`party_deed:theft` → `party_deed:`). Имя семейства без
/// суффикса само по себе предикатом не является.
pub fn predicate_entry_for(name: &str) -> Option<&'static PredicateEntry> {
    if let Some(exact) = predicate(name) {
        if !exact.family {
            return Some(exact);
        }
    }
    // `name.indexOf(':')` — позиция в UTF-16; сравниваются только «меньше 1» и
    // «последний символ», а срез до двоеточия включительно один и тот же, так
    // что байтовая позиция даёт тот же исход.
    let colon = name.find(':')?;
    if colon < 1 || colon == name.len() - 1 {
        return None;
    }
    predicate(&name[..=colon]).filter(|family| family.family)
}

/// Нарушение словаря при записи (`ontologyViolation`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OntologyViolation {
    pub code: &'static str,
    pub message: String,
}

/// Проверка одной записи памяти по словарю (`ontologyViolation`,
/// `server/world-ontology.mjs:295`): предикат известен, вид записи (`fact` или
/// `claim`) совпадает со статьёй, подлежащее — сущность допустимого вида. Для
/// утверждения подлежащее — держатель слуха или убеждения. Вид подлежащего
/// всегда строка: память нормализуется до проверки (`safeEntity` ставит
/// `concept` вместо неизвестного вида); пустой вид печатается «без вида».
pub fn ontology_violation(record: &str, predicate_name: &str, subject_kind: &str) -> Option<OntologyViolation> {
    let Some(entry) = predicate_entry_for(predicate_name) else {
        return Some(OntologyViolation { code: "WORLD_PREDICATE_UNKNOWN", message: format!("Предиката «{predicate_name}» нет в онтологии мира") });
    };
    if entry.record != record {
        let message = if entry.record == "claim" { format!("«{predicate_name}» — утверждение NPC, а не факт") } else { format!("«{predicate_name}» — факт мира, а не утверждение NPC") };
        return Some(OntologyViolation { code: "WORLD_PREDICATE_RECORD_MISMATCH", message });
    }
    if !entry.subject_kinds.contains(&subject_kind) {
        let shown = if subject_kind.is_empty() { "без вида" } else { subject_kind };
        return Some(OntologyViolation {
            code: "WORLD_PREDICATE_SUBJECT_KIND_INVALID",
            message: format!("«{predicate_name}» записывается о сущности вида {}, а не {shown}", entry.subject_kinds.join(", ")),
        });
    }
    None
}

/// Модули, где слова `predicate`/`relation` означают другое.
const NON_MEMORY_FILES: [&str; 6] = ["trace-store", "combat-spells", "campaign-controls", "rule-pack", "rule-retriever", "free-action-adjudication"];

fn non_memory_line() -> &'static Regex {
    re!(r"traceStore\.|\{\s*predicate\s*:\s*is[A-Z]\w*\s*\}", "u")
}

fn match_spec_line() -> &'static Regex {
    re!(r"\b(?:required_?[Ff]act|match(?:Spec)?|pattern|query)\b", "u")
}

/// Вхождение предиката или отношения (`Occurrence`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Occurrence {
    pub file: String,
    pub line: usize,
    pub name: String,
    pub family: bool,
    pub record: &'static str,
}

/// Место без литерала (`DynamicSite`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DynamicSite {
    pub file: String,
    pub line: usize,
    pub expression: String,
    pub kind: &'static str,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct OccurrenceBuckets {
    pub predicates: Vec<Occurrence>,
    pub relations: Vec<Occurrence>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DynamicBuckets {
    pub produced: Vec<DynamicSite>,
    pub consumed: Vec<DynamicSite>,
}

/// Итог разбора одного модуля (`ScanResult`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ScanResult {
    pub produced: OccurrenceBuckets,
    pub consumed: OccurrenceBuckets,
    pub dynamic: DynamicBuckets,
}

struct Literal {
    name: String,
    family: bool,
}

fn literals_in(expression: &str) -> Vec<Literal> {
    let mut found = Vec::new();
    for captures in re!(r#"'([a-z][a-z0-9_]*:?)'|"([a-z][a-z0-9_]*:?)""#, "gu").captures_iter(expression).filter_map(Result::ok) {
        let name = captures.get(1).or_else(|| captures.get(2)).map(|m| m.as_str().to_string()).unwrap_or_default();
        found.push(Literal { name, family: false });
    }
    for captures in re!(r"`([a-z][a-z0-9_]*:)\$\{", "gu").captures_iter(expression).filter_map(Result::ok) {
        found.push(Literal { name: captures.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(), family: true });
    }
    found
}

/// Запись утверждения или факта: смотрим на несколько строк вверх.
fn record_kind_at(lines: &[&str], index: usize) -> &'static str {
    for cursor in (index.saturating_sub(10)..=index).rev() {
        let line = lines[cursor];
        if text::test(re!(r"RecordRumor|RecordNpcBelief|\bclaim\s*:\s*\{", "u"), line) {
            return "claim";
        }
        if text::test(re!(r"RecordWorldFact|WorldFactRecorded|\bfact\s*:\s*\{", "u"), line) {
            return "fact";
        }
    }
    "fact"
}

/// Выражения сканера для одного поля (`predicate` или `relation`).
struct FieldPatterns {
    write: Regex,
    passthrough: Regex,
    shorthand: Regex,
    compare: Regex,
    reversed: Regex,
    starts_with: Regex,
    set_has: Regex,
    includes: Regex,
    regex_test: Regex,
}

impl FieldPatterns {
    fn new(field: &str) -> Self {
        let build = |source: String, flags: &str| text::js_regex(&source, flags).expect("выражение сканера онтологии");
        Self {
            write: build(format!(r"(?<![\w.]){field}\s*:\s*([^,}}\n]+)"), "gu"),
            passthrough: build(format!(r"\.{field}\b"), "u"),
            shorthand: build(format!(r"^\s*{field},\s*$"), "u"),
            compare: build(format!(r"\.{field}\b[^=\n]{{0,24}}?[!=]==?\s*(\S+)"), "gu"),
            reversed: build(format!(r#"(['"])([a-z][a-z0-9_]*)\1\s*[!=]==?\s*[\w?.]+\.{field}\b"#), "gu"),
            starts_with: build(format!(r#"\.{field}\??\.startsWith\(\s*(['"])([a-z][a-z0-9_]*:?)\1"#), "gu"),
            set_has: build(format!(r"([A-Z][A-Z0-9_]*)\.has\([^)]*\.{field}\)"), "gu"),
            includes: build(format!(r"\[([^\]]*)\]\.includes\([^)]*\.{field}\)"), "gu"),
            regex_test: build(format!(r"\/[^/\n]+\/[a-z]*\.test\([^)]*\.{field}\b"), "u"),
        }
    }
}

static PREDICATE_PATTERNS: LazyLock<FieldPatterns> = LazyLock::new(|| FieldPatterns::new("predicate"));
static RELATION_PATTERNS: LazyLock<FieldPatterns> = LazyLock::new(|| FieldPatterns::new("relation"));

/// `text.slice(0, limit)` по единицам UTF-16, как в JS. Разрезанная пара
/// суррогатов в строке Rust непредставима: половина отбрасывается.
fn utf16_head(value: &str, limit: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in value.chars() {
        units += ch.len_utf16();
        if units > limit {
            break;
        }
        out.push(ch);
    }
    out
}

/// `String(source).split(/\r?\n/u)`.
fn split_lines(source: &str) -> Vec<&str> {
    let pieces: Vec<&str> = source.split('\n').collect();
    let last = pieces.len() - 1;
    pieces.into_iter().enumerate().map(|(index, piece)| if index < last { piece.strip_suffix('\r').unwrap_or(piece) } else { piece }).collect()
}

fn captures<'t>(regex: &Regex, text: &'t str) -> Vec<sk_core::fancy_regex::Captures<'t, str>> {
    regex.captures_iter(text).filter_map(Result::ok).collect()
}

fn group(captures: &sk_core::fancy_regex::Captures<'_, str>, index: usize) -> String {
    captures.get(index).map(|m| m.as_str().to_string()).unwrap_or_default()
}

/// Статический разбор одного модуля (`scanOntologyUsage`): запись, чтение
/// сравнением и динамика без литерала. Сканер построчный и сознательно простой.
pub fn scan_ontology_usage(file: &str, source: &str) -> ScanResult {
    let mut result = ScanResult::default();
    if NON_MEMORY_FILES.contains(&file) {
        return result;
    }
    let lines = split_lines(source);
    let mut set_constants: HashMap<String, Vec<String>> = HashMap::new();
    for found in captures(re!(r"const\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:Object\.freeze\()?new Set\(\[([^\]]*)\]", "gu"), source) {
        set_constants.insert(group(&found, 1), literals_in(&group(&found, 2)).into_iter().map(|literal| literal.name).collect());
    }
    for (index, line) in lines.iter().enumerate() {
        let line_number = index + 1;
        let trimmed = text::trim(line);
        if trimmed.starts_with("//") || trimmed.starts_with('*') || trimmed.starts_with("/*") {
            continue;
        }
        if text::test(non_memory_line(), line) {
            continue;
        }
        for field in ["predicate", "relation"] {
            let patterns: &FieldPatterns = if field == "predicate" { &PREDICATE_PATTERNS } else { &RELATION_PATTERNS };
            // Отношение — поле записи памяти, только если рядом есть from_entity_id.
            if field == "relation" {
                let window = lines[index.saturating_sub(4)..(index + 5).min(lines.len())].join("\n");
                if !text::test(re!(r"from_entity_id", "u"), &window) {
                    continue;
                }
            }
            let occurrence = |name: String, family: bool, record: &'static str| Occurrence { file: file.to_string(), line: line_number, name, family, record };
            let site = |expression: String, kind: &'static str| DynamicSite { file: file.to_string(), line: line_number, expression, kind };
            // Запись: `field: <выражение>` до запятой, закрывающей скобки или конца строки.
            for found in captures(&patterns.write, line) {
                let expression = text::trim(&group(&found, 1)).to_string();
                // В тернарнике значение — ветви после `?`.
                let conditional = text::capture(re!(r"\?(.+)$", "u"), &expression, 1);
                let literals = literals_in(conditional.as_deref().unwrap_or(&expression));
                let as_spec = text::test(match_spec_line(), line);
                if literals.is_empty() {
                    let kind = if text::test(&patterns.passthrough, &expression) { "passthrough" } else { "dynamic" };
                    result.dynamic.produced.push(site(utf16_head(&expression, 120), kind));
                } else {
                    let record = record_kind_at(&lines, index);
                    let bucket = if as_spec { &mut result.consumed } else { &mut result.produced };
                    let target = if field == "predicate" { &mut bucket.predicates } else { &mut bucket.relations };
                    for literal in literals {
                        target.push(occurrence(literal.name, literal.family, record));
                    }
                }
            }
            // Сокращённая запись `{ predicate, … }` в объекте-черновике.
            if text::test(&patterns.shorthand, line) {
                result.dynamic.produced.push(site(field.to_string(), "passthrough"));
            }
            let consumed = if field == "predicate" { &mut result.consumed.predicates } else { &mut result.consumed.relations };
            let mut dynamic_consumed: Vec<DynamicSite> = Vec::new();
            // Чтение сравнением.
            for found in captures(&patterns.compare, line) {
                let literals = literals_in(&group(&found, 1));
                if literals.is_empty() {
                    dynamic_consumed.push(site(utf16_head(text::trim(line), 160), "dynamic"));
                } else {
                    for literal in literals {
                        consumed.push(occurrence(literal.name, false, "fact"));
                    }
                }
            }
            for found in captures(&patterns.reversed, line) {
                consumed.push(occurrence(group(&found, 2), false, "fact"));
            }
            for found in captures(&patterns.starts_with, line) {
                consumed.push(occurrence(group(&found, 2), true, "fact"));
            }
            for found in captures(&patterns.set_has, line) {
                match set_constants.get(&group(&found, 1)).filter(|names| !names.is_empty()) {
                    Some(names) => {
                        for name in names {
                            consumed.push(occurrence(name.clone(), false, "fact"));
                        }
                    }
                    None => dynamic_consumed.push(site(utf16_head(text::trim(line), 160), "dynamic")),
                }
            }
            for found in captures(&patterns.includes, line) {
                for literal in literals_in(&group(&found, 1)) {
                    consumed.push(occurrence(literal.name, false, "fact"));
                }
            }
            if text::test(&patterns.regex_test, line) {
                dynamic_consumed.push(site(utf16_head(text::trim(line), 160), "dynamic"));
            }
            result.dynamic.consumed.extend(dynamic_consumed);
        }
    }
    result
}

#[derive(Default)]
struct AuditEntry {
    family: bool,
    record: IndexSet<&'static str>,
    producers: IndexSet<String>,
    consumers: IndexSet<String>,
    sites: Vec<String>,
}

type AuditTable = IndexMap<String, AuditEntry>;

fn add(table: &mut AuditTable, occurrence: &Occurrence, producer: bool) {
    let entry = table.entry(occurrence.name.clone()).or_insert_with(|| AuditEntry { family: occurrence.family, ..AuditEntry::default() });
    entry.family |= occurrence.family;
    if producer {
        entry.record.insert(occurrence.record);
        entry.producers.insert(occurrence.file.clone());
    } else {
        entry.consumers.insert(occurrence.file.clone());
    }
    entry.sites.push(format!("{} server/{}.mjs:{}", if producer { "W" } else { "R" }, occurrence.file, occurrence.line));
}

fn sorted<T: AsRef<str>>(items: impl IntoIterator<Item = T>) -> Vec<String> {
    let mut list: Vec<String> = items.into_iter().map(|item| item.as_ref().to_string()).collect();
    list.sort_by(|a, b| utf16_cmp(a, b));
    list
}

fn serialize(table: &AuditTable) -> Value {
    let mut map = Map::new();
    for name in sorted(table.keys()) {
        let entry = &table[&name];
        map.insert(
            name,
            json!({
                "family": entry.family,
                "record": sorted(entry.record.iter()),
                "producers": sorted(entry.producers.iter()),
                "consumers": sorted(entry.consumers.iter()),
                "sites": entry.sites,
            }),
        );
    }
    Value::Object(map)
}

fn consumed_without_producer(table: &AuditTable) -> Vec<String> {
    sorted(
        table
            .iter()
            .filter(|(name, entry)| {
                !entry.consumers.is_empty()
                    && entry.producers.is_empty()
                    && !(name.ends_with(':') && table.iter().any(|(other, candidate)| other.starts_with(name.as_str()) && !candidate.producers.is_empty()))
            })
            .map(|(name, _)| name),
    )
}

fn produced_without_consumer(table: &AuditTable) -> Vec<String> {
    sorted(table.iter().filter(|(_, entry)| !entry.producers.is_empty() && entry.consumers.is_empty()).map(|(name, _)| name))
}

fn dynamic_json(sites: &[DynamicSite]) -> Vec<Value> {
    sites
        .iter()
        .map(|site| json!({ "file": site.file, "line": site.line, "expression": site.expression, "kind": site.kind, "at": format!("server/{}.mjs:{}", site.file, site.line) }))
        .collect()
}

/// Сводка по нескольким модулям (`auditOntology`): кто что пишет и читает, и
/// где разрывы. `files` — пары `(имя модуля без расширения, текст)`.
pub fn audit_ontology(files: &[(&str, &str)]) -> Value {
    let mut predicates = AuditTable::new();
    let mut relations = AuditTable::new();
    let mut dynamic_produced: Vec<DynamicSite> = Vec::new();
    let mut dynamic_consumed: Vec<DynamicSite> = Vec::new();
    for (file, source) in files {
        let scan = scan_ontology_usage(file, source);
        for occurrence in &scan.produced.predicates {
            add(&mut predicates, occurrence, true);
        }
        for occurrence in &scan.consumed.predicates {
            add(&mut predicates, occurrence, false);
        }
        for occurrence in &scan.produced.relations {
            add(&mut relations, occurrence, true);
        }
        for occurrence in &scan.consumed.relations {
            add(&mut relations, occurrence, false);
        }
        dynamic_produced.extend(scan.dynamic.produced);
        dynamic_consumed.extend(scan.dynamic.consumed);
    }
    json!({
        "predicates": serialize(&predicates),
        "relations": serialize(&relations),
        "gaps": {
            "consumed_but_never_produced": { "predicates": consumed_without_producer(&predicates), "relations": consumed_without_producer(&relations) },
            "produced_but_never_consumed": { "predicates": produced_without_consumer(&predicates), "relations": produced_without_consumer(&relations) },
        },
        "dynamic": { "produced": dynamic_json(&dynamic_produced), "consumed": dynamic_json(&dynamic_consumed) },
    })
}

/// Реестр предикатов в форме JS (`PREDICATES`).
pub fn predicates_json() -> Value {
    Value::Object(PREDICATES.iter().map(|(name, entry)| (name.to_string(), entry.to_json())).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanner_catches_the_discovery_gap() {
        let consumer = [
            "const QUEST_PROGRESS_PREDICATES = new Set(['discovery', 'quest_progress'])",
            "const facts = memory.facts.filter((fact) => QUEST_PROGRESS_PREDICATES.has(fact.predicate))",
        ]
        .join("\n");
        let producer = ["commands.push({ command_type: 'RecordWorldFact', fact: {", "  id: 'x', subject_id: 'npc', predicate: 'discovery', object: 'clue',", "} })"].join("\n");
        let before = audit_ontology(&[("world-memory", &consumer)]);
        assert_eq!(before["gaps"]["consumed_but_never_produced"]["predicates"], json!(["discovery", "quest_progress"]));
        let after = audit_ontology(&[("world-memory", &consumer), ("free-action", &producer)]);
        assert_eq!(after["gaps"]["consumed_but_never_produced"]["predicates"], json!(["quest_progress"]));
    }

    #[test]
    fn scanner_tells_write_spec_ternary_family_and_claim_apart() {
        let source = [
            "const requiredFact = event.event_type === 'NpcDied' ? { subject_id: id, predicate: 'died' } : null",
            "const blessing = { predicate: source === 'priest' ? 'blessed_by_priest' : 'blessed_at_shrine' }",
            "commands.push({ command_type: 'RecordRumor', claim: {",
            "  predicate: `party_deed:${kind}`,",
            "} })",
            "if (String(event.payload?.fact?.predicate ?? '') === 'died') return",
            "const known = (fact) => fact.predicate.startsWith('faction_offscreen_move:')",
            "const copy = { predicate: template.predicate }",
            "const ignored = traceStore.latest(id, { predicate: isMechanicalTrace })",
        ]
        .join("\n");
        let scan = scan_ontology_usage("sample", &source);
        let produced: Vec<(&str, &str)> = scan.produced.predicates.iter().map(|entry| (entry.name.as_str(), entry.record)).collect();
        assert_eq!(produced, [("blessed_by_priest", "fact"), ("blessed_at_shrine", "fact"), ("party_deed:", "claim")]);
        let consumed: Vec<&str> = scan.consumed.predicates.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(consumed, ["died", "died", "faction_offscreen_move:"]);
        let kinds: Vec<&str> = scan.dynamic.produced.iter().map(|entry| entry.kind).collect();
        assert_eq!(kinds, ["passthrough"]);
    }

    #[test]
    fn relation_counts_only_next_to_from_entity_id() {
        let source = ["return { hazard_id: hazardId, relation: 'contact' }", "", "", "", "", "", "relationship: { id: 'r1', from_entity_id: 'a', relation: 'serves', to_entity_id: 'b' }"].join("\n");
        let scan = scan_ontology_usage("sample", &source);
        let names: Vec<&str> = scan.produced.relations.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, ["serves"]);
    }

    #[test]
    fn external_only_list_matches_the_registry() {
        let mut declared: Vec<&str> = PREDICATES.iter().filter(|(_, entry)| entry.producers.is_empty()).map(|(name, _)| *name).collect();
        declared.sort();
        assert_eq!(declared, EXTERNAL_ONLY_PREDICATES);
        for name in EXTERNAL_ONLY_PREDICATES {
            let entry = predicate(name).expect("внешний предикат описан");
            assert!(entry.external_producers.is_some_and(|list| !list.is_empty()));
            // Без конкретного читателя внешний предикат допустим, только если он
            // объявлен для общих читателей (#189).
            assert!(!entry.consumers.is_empty() || entry.generic_readers_only);
        }
    }
}

//! Перенос `server/spell-acceptance-audit.mjs`: read-only инвентаризация
//! приёмки всех 439 заклинаний кругов 0–6 в редакции D&D 2014 для
//! `pnpm spells:verify --acceptance`. Паспорт заклинания разделяет доступность
//! (статус механики) и полную приёмку по пяти измерениям; готовность
//! принимается только с привязанными доказательствами — receipt зависимостей
//! (`docs/acceptance/*.json`) или хеш рабочего дерева.
//!
//! Модуль читает файлы репозитория и историю Git, как и JS: отпечатки
//! зависимостей, сохранённые доказательства, исходную ревизию каталога
//! (`git show`), текущую ревизию и снимок рабочего дерева. Корень репозитория
//! по умолчанию — тот, из которого собран крейт ([`repository_root`]).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::hash::sha256_hex;
use sk_core::indexmap::IndexSet;
use sk_core::{clock, js, re, text};

use crate::combat_spells::{canonical_combat_spell_for, catalog_payload};
use crate::jsv::{self, array, defined, is_str, prop};

const CATALOG_PATH: &str = "data/dndsu-spells-0-6.json";
const OVERRIDES_PATH: &str = "data/dndsu-spell-mechanics-overrides.json";

/// Сохранённое доказательство пилота «Скороход».
pub const LONGSTRIDER_EVIDENCE_PATH: &str = "docs/acceptance/longstrider-evidence.json";
/// Сохранённое доказательство первой партии проверенных профилей 2014.
pub const BASIC_SPELL_EVIDENCE_PATH: &str = "docs/acceptance/spell-basic-2014-evidence.json";

/// Зависимости доказательства первой партии.
pub const BASIC_SPELL_EVIDENCE_DEPENDENCIES: [&str; 44] = [
    CATALOG_PATH, OVERRIDES_PATH, "package.json", "pnpm-lock.yaml",
    "data/rule_packs/dnd_5e_2014/manifest.yaml",
    "server/combat-spells.mjs", "server/rules-engine.mjs", "server/event-store.mjs",
    "server/index.mjs", "server/security.mjs", "server/viewer-projection.mjs",
    "server/character-creation-catalog.mjs", "server/character-creation-phb.mjs",
    "server/character-creation-class-options.mjs", "server/character-progression.mjs",
    "server/item-catalog.mjs", "server/dice-service.mjs", "server/ruleset-config.mjs",
    "server/tactical-map.mjs", "server/dynamic-map.mjs", "server/npc-positioning.mjs",
    "server/spell-acceptance-audit.mjs", "server/spell-override-audit.mjs",
    "src/App.tsx", "src/DungeonMap.tsx", "src/SpellDetail.tsx", "src/Spellbook.tsx",
    "src/CharacterCreationWizard.tsx", "src/useGameSession.ts", "src/types.ts",
    "src/combat-spells.ts", "src/spell-targeting.ts", "src/spell-explanations.ts",
    "src/TacticalBoard.tsx", "src/TacticalBoard3D.tsx", "src/combat-animation.ts",
    "src/spell-effects.ts", "src/board3d-spell-effects.ts", "src/combat-audio.ts",
    "test/basic-spell-fixture.mjs", "test/spell-basic-2014.test.mjs",
    "test/spell-acceptance-audit.test.mjs",
    "test/rules-dndsu-2014-review.test.mjs", "test/spell-components-mechanics.test.mjs",
];

/// Явная консервативная граница первого пилота: зависимости доказательства,
/// а не второй каталог. Сам receipt и документация в собственный хеш не входят.
pub const LONGSTRIDER_EVIDENCE_DEPENDENCIES: [&str; 61] = [
    CATALOG_PATH, OVERRIDES_PATH, "data/rule_packs/dnd_5e_2014/manifest.yaml",
    "package.json", "pnpm-lock.yaml",
    "server/combat-spells.mjs", "server/rules-engine.mjs", "server/event-store.mjs", "server/campaign-bootstrap.mjs",
    "server/character-progression.mjs", "server/character-creation-catalog.mjs", "server/character-creation-feats.mjs",
    "server/index.mjs", "server/security.mjs", "server/viewer-projection.mjs",
    "server/tactical-map.mjs", "server/dynamic-map.mjs", "server/dice-service.mjs", "server/ruleset-config.mjs",
    "server/weather.mjs", "server/courier-letters.mjs", "server/offscreen-world.mjs", "server/item-dawn-recharge.mjs", "server/npc-social.mjs",
    "server/npc-turn-scheduler.mjs", "server/npc-controller.mjs", "server/party-tactics.mjs",
    "server/spell-acceptance-audit.mjs", "tools/verify-spell-overrides.mjs",
    "src/App.tsx", "src/DungeonMap.tsx", "src/TacticalBoard.tsx", "src/TacticalBoard3D.tsx",
    "src/types.ts", "src/tactical-ui.ts", "src/useGameSession.ts", "src/styles.css",
    "src/spell-effects.ts", "src/board3d-spell-effects.ts", "src/combat-animation.ts", "src/combat-audio.ts",
    "test/longstrider.test.mjs", "test/longstrider-api.test.mjs", "test/longstrider-projection.test.mjs",
    "test/world-time-seconds.test.mjs", "test/rules-engine.test.mjs", "test/movement-event-compat.test.mjs",
    "test/spell-acceptance-audit.test.mjs", "test/multi-target-spell-ui.test.mjs",
    "test/tactical-ui.test.mjs", "test/spell-effects.test.mjs", "test/board3d-spell-effects.test.mjs",
    "test/combat-audio.test.mjs", "test/npc-turn-scheduler.test.mjs",
    "test/death-saves.test.mjs", "test/rest-mechanics.test.mjs", "test/item-dawn-recharge.test.mjs",
    "test/group-initiative.test.mjs", "test/event-store.test.mjs", "test/campaign-bootstrap.test.mjs", "test/mvp-player-cycle-api.test.mjs",
];

/// Исходная контрольная точка каталога, относительно которой считаются группы.
pub const SPELL_ACCEPTANCE_BASELINE: &str = "9277df04985856208f2bfd1590a5916c60b3ef82";
/// Измерения приёмки.
pub const SPELL_ACCEPTANCE_DIMENSIONS: [&str; 5] = ["rules", "playerPath", "resilience", "permissions", "presentation"];

const SUPPORT_STATUSES: [&str; 4] = ["verified", "partial", "heuristic", "ruling-only"];
const BLOCKED_STATUSES: [&str; 2] = ["heuristic", "ruling-only"];

/// Очередь проверки четырёх пилотов, а не второй каталог заклинаний: наличие
/// требования или сценария никогда не означает пройденную приёмку.
static PILOTS: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(PILOTS_JSON).expect("пилоты приёмки"));
static COMMON_SCENARIOS: LazyLock<Vec<Value>> = LazyLock::new(|| array(Some(&serde_json::from_str(COMMON_SCENARIOS_JSON).expect("общие сценарии"))).to_vec());
static BASIC_SCENARIOS: LazyLock<Vec<Value>> = LazyLock::new(|| array(Some(&serde_json::from_str(BASIC_SCENARIOS_JSON).expect("сценарии партии"))).to_vec());

const PILOTS_JSON: &str = r##"{"longstrider":{"publication":"Legacy Basic Rules (2014), p. 256","reviewReferences":[{"url":"https://www.dndbeyond.com/spells/2171-longstrider","scope":"rule-description"}],"remainder":"Реализован частичный профиль скорости, сроков и усиления. Итоговый gate и ручная приёмка двух игроков в 2D/3D со звуком требуют актуального evidence; доступность не означает полную приёмку.","dependencies":["timed-speed-modifier","upcast-targets","effect-source-identity","world-time-expiry"],"choices":["цели касанием","источник и круг ячейки","дополнительные цели при усилении"],"lifecycle":["наложение","движение и Рывок","бой → исследование","истечение часа","снятие конкретного источника"],"scenarios":[["speed-and-dash","rules","+10 футов изменяют допустимый маршрут и Рывок; иконка без изменения движения недостаточна."],["touch-and-upcast","rules","Касание каждой цели, дополнительные цели по кругу; отказ до расхода при лишней или далёкой цели."],["hour-and-sources","rules","Час игровых минут, переход бой/исследование, повторное наложение и несколько источников без сложения одинакового эффекта."]]},"mass-cure-wounds":{"publication":"Legacy Basic Rules (2014), p. 258","reviewReferences":[{"url":"https://www.dndbeyond.com/spells/2181-mass-cure-wounds","scope":"rule-description"}],"remainder":"Нужны точка и выбранное подмножество до шести целей, 3к8 с усилением, исключения по типам существ; текущая общая карточка этого не доказывает.","dependencies":["point-and-selected-targets","healing-upcast","creature-type-filter","zero-hp-lifecycle"],"choices":["точка в пределах дальности","до шести существ вокруг точки","источник и круг ячейки"],"lifecycle":["проверка точки и всех целей","однократное лечение и расход","обновление ОЗ и состояний"],"scenarios":[["point-and-six-targets","rules","Точка в пределах 60 футов, до шести выбранных существ в радиусе 30 футов; усиление не увеличивает их число."],["healing-and-types","rules","3к8 + модификатор, +1к8 за круг выше пятого, предел максимума ОЗ, исключение нежити и конструктов, состояние при 0 ОЗ."],["select-targets-on-site","playerPath","Обычный игрок выбирает точку и получателей с разными ID даже при одинаковых именах, отменяет и подтверждает выбор."]]},"protection-from-energy":{"publication":"Legacy Basic Rules (2014)","reviewReferences":[{"url":"https://www.dndbeyond.com/spells/2220-protection-from-energy","scope":"rule-description"}],"remainder":"Нужны настоящее сопротивление выбранному типу, серверное согласие цели, концентрация и час действия; маркер преимущества спасброска не заменяет сопротивление урону.","dependencies":["typed-resistance","concentration","effect-source-identity","world-time-expiry","willing-target-policy"],"choices":["согласная цель касанием","кислота / холод / огонь / электричество / звук","источник ячейки"],"lifecycle":["получение согласия","наложение","смешанный урон","срыв концентрации","истечение часа","снятие конкретного эффекта"],"scenarios":[["selected-resistance","rules","Сопротивление выбранному типу; другой и смешанный урон, пересечение с другими источниками сопротивления и иммунитетом."],["concentration-and-expiry","rules","Концентрация до часа; прекращение снимает только соответствующий экземпляр защиты."],["willing-player","permissions","Согласие другого игрока определяется серверной политикой; произвольное клиентское поле согласие не подтверждает."]]},"destructive-wave":{"publication":"PH14 по карточке 5e14.dnd.su; полный официальный текст независимо не подтверждён","reviewReferences":[{"url":"https://5e14.dnd.su/spells/296-destructive-wave/","scope":"project-source-description"},{"url":"https://www.dndbeyond.com/spells/class/4-paladin","scope":"catalog-only"}],"remainder":"Нужны выбранные цели, спасбросок, две составляющие урона и падение при провале; законный доступ героя до 12-го уровня требует проверки прогрессии домена Бури.","dependencies":["selected-area-targets","mixed-damage","saving-throw","condition-immunity","zero-hp-lifecycle","legal-spell-acquisition"],"choices":["выбранные существа в пределах 30 футов","излучение или некротическая энергия","допустимый источник магии"],"lifecycle":["выбор и проверка целей","спасбросок каждой цели","два типа урона","падение только при провале","однократная фиксация выбытия"],"scenarios":[["mixed-save-and-prone","rules","Спасбросок Телосложения: 5к6 звуком + 5к6 выбранным типом, половина при успехе; ничком только при провале с учётом иммунитета."],["mixed-resistance-and-death","rules","Раздельные сопротивления к двум составляющим, выбранные цели, одно выбытие при последовательных компонентах урона."],["legal-level-twelve-path","playerPath","Получение заклинания допустимым способом при ограничении героя 12-м уровнем; административная выдача этого не доказывает."]]}}"##;
const COMMON_SCENARIOS_JSON: &str = r##"[["source-and-exceptions","rules","Сверить принятую редакцию, публикацию, исключения и все ветки конкретной карточки; профиль сам по себе не подтверждает правило."],["refusal-before-spending","rules","Недопустимая цель, дальность, видимость, компоненты, ресурс и экономика хода отклоняются до расхода."],["normal-acquisition-and-cast","playerPath","Получение/изучение, подготовка, компоненты и применение обычным игроком через основной HTTP/UI-путь."],["replay-restart-idempotency","resilience","Тот же результат после replay/restart, повтор запроса без второго расхода, конфликт версии и совместимость старых событий."],["ownership-and-projection","permissions","Владение, членство, недоверенные поля и скрытые цели; два игрока видят только разрешённое."],["two-player-2d-3d-av","presentation","Ручной основной сценарий с двумя игроками: 2D/3D, отмена, подтверждённый эффект, анимация и звук без раскрытия скрытого."]]"##;
const BASIC_SCENARIOS_JSON: &str = r##"[["effect-and-exceptions","rules","Поимённые числовые ожидания, типы целей, иммунитеты, промах/успех, классовые бонусы и особые ограничения карточки."],["lifecycle-and-upcast","rules","Каждая доступная ячейка I–VI, рост заговоров, точное окончание эффекта, концентрация и повторное наложение."]]"##;

/// ID рабочего каталога (`CATALOG_IDS`); каталог встроен в сборку.
static CATALOG_IDS: LazyLock<IndexSet<String>> = LazyLock::new(|| array(catalog_payload().get("spells")).iter().map(|spell| js::s(spell.get("id"))).collect());

fn pilot(id: &str) -> Option<&'static Value> {
    PILOTS.get(id)
}

fn scenario_triples(list: &[Value]) -> Vec<(String, String, String)> {
    list.iter().map(|entry| (js::s(entry.get(0)), js::s(entry.get(1)), js::s(entry.get(2)))).collect()
}

/// Корень репозитория, из которого собран крейт (`new URL('../', import.meta.url)`).
pub fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
}

/// Ошибка чтения файла репозитория.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadError {
    pub not_found: bool,
    pub message: String,
}

fn read(root: &Path, path: &str) -> Result<String, ReadError> {
    match std::fs::read(root.join(path)) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(error) => Err(ReadError { not_found: error.kind() == std::io::ErrorKind::NotFound, message: format!("{path}: {error}") }),
    }
}

fn sha256(text: &str) -> String {
    sha256_hex(text.as_bytes())
}

/// Отпечаток текстовой зависимости: перевод строк Windows не должен
/// устаревать доказательство.
pub fn spell_evidence_text_sha256(text: &str) -> String {
    sha256(&text.replace("\r\n", "\n"))
}

fn fingerprints_of(root: &Path, paths: &[&str]) -> Result<Map<String, Value>, String> {
    let mut fingerprints = Map::new();
    for path in paths {
        let text = read(root, path).map_err(|error| error.message)?;
        fingerprints.insert(path.to_string(), Value::from(spell_evidence_text_sha256(&text)));
    }
    Ok(fingerprints)
}

/// Отпечатки зависимостей первой партии по текущим файлам.
pub fn basic_spell_dependency_fingerprints(root: &Path) -> Result<Map<String, Value>, String> {
    fingerprints_of(root, &BASIC_SPELL_EVIDENCE_DEPENDENCIES)
}

/// Отпечатки зависимостей пилота «Скороход» по текущим файлам.
pub fn longstrider_dependency_fingerprints(root: &Path) -> Result<Map<String, Value>, String> {
    fingerprints_of(root, &LONGSTRIDER_EVIDENCE_DEPENDENCIES)
}

/// Сохранённое доказательство: JSON файла, `null` без файла, иначе отметка
/// о нечитаемом файле.
fn read_evidence(root: &Path, path: &str, invalid: Value) -> Value {
    match read(root, path) {
        Ok(text) => serde_json::from_str::<Value>(&text).map(jsv::js_ordered_deep).unwrap_or(invalid),
        Err(error) if error.not_found => Value::Null,
        Err(_) => invalid,
    }
}

/// Сохранённое доказательство первой партии.
pub fn read_basic_spell_evidence(root: &Path) -> Value {
    read_evidence(root, BASIC_SPELL_EVIDENCE_PATH, json!({ "status": "invalid" }))
}

/// Сохранённое доказательство пилота «Скороход».
pub fn read_longstrider_evidence(root: &Path) -> Value {
    read_evidence(root, LONGSTRIDER_EVIDENCE_PATH, json!({ "status": "invalid", "error": "Файл evidence не является читаемым JSON." }))
}

/// Пары `Object.entries(value)` для объекта, массива и строки.
fn object_entries(value: Option<&Value>) -> Vec<(String, Value)> {
    match value {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Vec::new(),
    }
}

/// `sha256(JSON.stringify(Object.entries(fingerprints ?? {}).sort(localeCompare)))`.
fn dependency_digest(fingerprints: Option<&Value>) -> String {
    let mut entries = object_entries(defined(fingerprints));
    entries.sort_by(|(left, _), (right, _)| text::locale_compare(left, right));
    let pairs: Vec<Value> = entries.into_iter().map(|(key, value)| json!([key, value])).collect();
    sha256(&jsv::stringify(&Value::Array(pairs)))
}

fn is_sha256(value: Option<&Value>) -> bool {
    text::test(re!(r"^[a-f0-9]{64}$", "u"), &jsv::s(defined(value)))
}

fn is_revision(value: Option<&Value>) -> bool {
    text::test(re!(r"^[a-f0-9]{40}$", "u"), &jsv::s(defined(value)))
}

fn date_is_valid(value: Option<&Value>) -> bool {
    clock::parse_iso(&jsv::string(value)).is_some()
}

fn truthy(value: Option<&Value>) -> bool {
    js::truthy(value)
}

/// `new Set(values).size` по SameValueZero (`undefined` — своё значение).
fn distinct_count(values: &[Option<&Value>]) -> usize {
    let mut seen: Vec<Option<&Value>> = Vec::new();
    for value in values {
        if !seen.iter().any(|known| jsv::strict_eq(*known, *value)) {
            seen.push(*value);
        }
    }
    seen.len()
}

/// `array.sort()` без сравнителя над полями: `undefined` — в конце, прочие —
/// по строковому виду; затем `JSON.stringify` (`undefined` в массиве — `null`).
fn sorted_json(values: Vec<Option<Value>>) -> String {
    let (mut defined_values, undefined_count): (Vec<Value>, usize) = values.into_iter().fold((Vec::new(), 0), |(mut list, count), value| match value {
        Some(value) => {
            list.push(value);
            (list, count)
        }
        None => (list, count + 1),
    });
    defined_values.sort_by_key(|value| jsv::string(Some(value)).encode_utf16().collect::<Vec<u16>>());
    defined_values.extend(std::iter::repeat_n(Value::Null, undefined_count));
    jsv::stringify(&Value::Array(defined_values))
}

fn sorted_strings(values: &[&str]) -> String {
    sorted_json(values.iter().map(|value| Some(Value::from(*value))).collect())
}

fn push_problem(result: &mut Map<String, Value>, message: &str) {
    if let Some(Value::Array(problems)) = result.get_mut("problems") {
        problems.push(Value::from(message));
    }
}

fn with_status(result: &Map<String, Value>, status: &str, problems: Option<Vec<&str>>) -> Value {
    let mut copy = result.clone();
    copy.insert("status".into(), Value::from(status));
    if let Some(problems) = problems {
        copy.insert("problems".into(), json!(problems));
    }
    Value::Object(copy)
}

fn inspection_base(reference: &str, record: Option<&Value>, fingerprints: &Map<String, Value>) -> Map<String, Value> {
    let fingerprints_value = Value::Object(fingerprints.clone());
    let mut result = Map::new();
    result.insert("reference".into(), Value::from(reference));
    result.insert("status".into(), Value::from("missing"));
    result.insert("testedRevision".into(), defined(prop(record, "testedRevision")).cloned().unwrap_or(Value::Null));
    result.insert("dependencyFingerprints".into(), fingerprints_value.clone());
    result.insert("dependencySha256".into(), Value::from(dependency_digest(Some(&fingerprints_value))));
    result.insert("problems".into(), json!([]));
    result
}

/// Ключи `Object.keys(record.dependencyFingerprints ?? {})`, по строкам.
fn recorded_keys_match(recorded: Option<&Value>, expected: &[&str], fingerprints: &Map<String, Value>) -> bool {
    let keys: Vec<String> = object_entries(defined(recorded)).into_iter().map(|(key, _)| key).collect();
    let actual = sorted_json(keys.iter().map(|key| Some(Value::from(key.clone()))).collect());
    if actual != sorted_strings(expected) {
        return false;
    }
    !keys.iter().any(|path| {
        let value = prop(defined(recorded), path);
        !is_sha256(value) || !jsv::strict_eq(value, fingerprints.get(path))
    })
}

const RECEIPT_REFERENCE: &str = r"^docs\/acceptance\/[\w.-]+\.md$";

fn receipt_reference_ok(run: Option<&Value>) -> bool {
    text::test(re!(RECEIPT_REFERENCE, "u"), &jsv::s(defined(jsv::path(run, &["receipt", "reference"]))))
}

fn find_run<'a>(runs: &'a [Value], id: Option<&Value>) -> Option<&'a Value> {
    runs.iter().find(|run| jsv::strict_eq(prop(Some(run), "id"), id))
}

fn inspect_basic_spell_evidence(record: Option<&Value>, fingerprints: &Map<String, Value>, expected_ids: &[String], catalog: &Value) -> Value {
    let record = defined(record);
    let mut result = inspection_base(BASIC_SPELL_EVIDENCE_PATH, record, fingerprints);
    let Some(record) = record else {
        return Value::Object(result);
    };
    let field = |key: &str| prop(Some(record), key);
    if !is_str(field("schemaVersion"), "spell-batch-evidence/v1") || !(is_str(field("status"), "pending") || is_str(field("status"), "recorded")) {
        return with_status(&result, "invalid", Some(vec!["Нужен spell-batch-evidence/v1 с явным результатом партии."]));
    }
    if is_str(field("status"), "pending") {
        return with_status(&result, "pending", None);
    }
    if !is_revision(field("testedRevision")) || !date_is_valid(field("observedAt")) {
        push_problem(&mut result, "Нужны исходная ревизия рабочего дерева и дата фактической проверки.");
    }
    if !recorded_keys_match(field("dependencyFingerprints"), &BASIC_SPELL_EVIDENCE_DEPENDENCIES, fingerprints) {
        return with_status(&result, "stale", Some(vec!["Доказательства первой партии устарели: зависимости изменились; требуется повторная проверка."]));
    }
    let runs = array(field("runs"));
    let run_ids: Vec<Option<&Value>> = runs.iter().map(|run| prop(Some(run), "id")).collect();
    if distinct_count(&run_ids) != runs.len() {
        push_problem(&mut result, "ID прогонов должны быть уникальны.");
    }
    for run in runs {
        let run = Some(run);
        let kind_ok = is_str(prop(run, "kind"), "test-run") || is_str(prop(run, "kind"), "manual-run");
        if !truthy(prop(run, "id"))
            || !kind_ok
            || !is_str(prop(run, "status"), "passed")
            || !truthy(prop(run, "command"))
            || !receipt_reference_ok(run)
            || !truthy(jsv::path(run, &["receipt", "artifact"]))
            || !is_sha256(jsv::path(run, &["receipt", "sha256"]))
        {
            push_problem(&mut result, "Успешный прогон требует команды, читаемого отчёта и хеша фактического артефакта.");
        }
    }
    if !runs.iter().any(|run| is_str(run.get("kind"), "test-run") && is_str(run.get("command"), "pnpm verify") && is_str(run.get("status"), "passed")) {
        push_problem(&mut result, "Нужен фактически успешный итоговый pnpm verify.");
    }
    let cards = array(field("spells"));
    let card_ids = sorted_json(cards.iter().map(|card| prop(Some(card), "spellId").cloned()).collect());
    let expected = sorted_json(expected_ids.iter().map(|id| Some(Value::from(id.clone()))).collect());
    if card_ids != expected {
        push_problem(&mut result, "Нужен точный набор проверенных профилей 2014 без удаления и добавления ID.");
    }
    let scenarios_expected: Vec<(String, String, String)> = scenario_triples(&COMMON_SCENARIOS).into_iter().chain(scenario_triples(&BASIC_SCENARIOS)).collect();
    for card in cards {
        let card = Some(card);
        let spell_id = prop(card, "spellId");
        let label = jsv::string(spell_id);
        let raw = array(catalog.get("spells")).iter().find(|spell| jsv::strict_eq(spell.get("id"), spell_id));
        let source = |key: &str| jsv::path(card, &["source", key]);
        let length_truthy = |key: &str| jsv::length(prop(card, key)).is_some_and(|length| length > 0);
        if raw.is_none()
            || !is_str(source("rulesetId"), "dnd_5e_2014")
            || !truthy(source("publication"))
            || !truthy(source("acceptedRevision"))
            || !is_sha256(source("htmlSha256"))
            || !is_sha256(source("descriptionSha256"))
            || !raw.is_some_and(|raw| is_str(source("cardSha256"), &sha256(&jsv::stringify(raw))))
            || !length_truthy("specification")
            || !length_truthy("choices")
            || !length_truthy("lifecycle")
        {
            push_problem(&mut result, &format!("Нет поимённой сверки и полного паспорта {label}."));
        }
        let scenarios = prop(card, "scenarios");
        let scenario_list = array(scenarios);
        let scenario_ids: Vec<Option<&Value>> = scenario_list.iter().map(|scenario| prop(Some(scenario), "id")).collect();
        if !scenarios.is_some_and(Value::is_array) || scenario_list.len() != scenarios_expected.len() || distinct_count(&scenario_ids) != scenarios_expected.len() {
            push_problem(&mut result, &format!("Неполный набор сценариев {label}."));
            continue;
        }
        for (id, dimension, _) in &scenarios_expected {
            let scenario = scenario_list.iter().find(|scenario| is_str(scenario.get("id"), id));
            let evidence_runs: Vec<Option<&Value>> = array(scenario.and_then(|scenario| defined(scenario.get("runIds")))).iter().map(|run_id| find_run(runs, Some(run_id))).collect();
            if !is_str(scenario.and_then(|scenario| scenario.get("status")), "passed") || evidence_runs.is_empty() || evidence_runs.iter().any(|run| !is_str(prop(*run, "status"), "passed")) {
                push_problem(&mut result, &format!("Не подтверждён {label}/{id}."));
            }
            if (dimension == "presentation" || id == "normal-acquisition-and-cast") && !evidence_runs.iter().any(|run| is_str(prop(*run, "kind"), "manual-run")) {
                push_problem(&mut result, &format!("Нужен основной браузерный путь {label}/{id}."));
            }
        }
    }
    let invalid = !array(result.get("problems")).is_empty();
    with_status(&result, if invalid { "invalid" } else { "current" }, None)
}

fn evidence_entry(run: Option<&Value>, record: &Value, inspection: &Value, reference: &str, scope: &str) -> Value {
    let mut entry = Map::new();
    let mut put = |key: &str, value: Option<&Value>| {
        if let Some(value) = value {
            entry.insert(key.into(), value.clone());
        }
    };
    put("kind", prop(run, "kind"));
    put("reference", jsv::path(run, &["receipt", "reference"]));
    put("observedAt", record.get("observedAt"));
    put("testedRevision", record.get("testedRevision"));
    put("dependencySha256", inspection.get("dependencySha256"));
    put("receiptSha256", jsv::path(run, &["receipt", "sha256"]));
    put("artifact", jsv::path(run, &["receipt", "artifact"]));
    put("command", prop(run, "command"));
    entry.insert("recordReference".into(), Value::from(reference));
    entry.insert("scope".into(), Value::from(scope));
    Value::Object(entry)
}

fn set_nested(card: &mut Map<String, Value>, key: &str, field: &str, value: Value) {
    if let Some(Value::Object(nested)) = card.get_mut(key) {
        nested.insert(field.into(), value);
    }
}

fn apply_basic_spell_evidence(card: &mut Map<String, Value>, record: &Value, inspection: &Value) {
    card.insert("evidenceRecord".into(), inspection.clone());
    if !is_str(inspection.get("status"), "current") {
        return;
    }
    let spell_id = card.get("spellId").cloned();
    let Some(saved) = array(record.get("spells")).iter().find(|entry| jsv::strict_eq(entry.get("spellId"), spell_id.as_ref())) else {
        return;
    };
    let mut source = card.get("source").and_then(Value::as_object).cloned().unwrap_or_default();
    jsv::spread_into(&mut source, saved.get("source"));
    card.insert("source".into(), Value::Object(source));
    let mut specification = Map::new();
    specification.insert("status".into(), Value::from("reviewed"));
    specification.insert("individuallyReviewed".into(), Value::Bool(true));
    specification.insert("detailedReference".into(), Value::from("docs/spell-basic-2014-2026-09-30.md"));
    if let Some(requirements) = saved.get("specification") {
        specification.insert("requirements".into(), requirements.clone());
    }
    card.insert("specification".into(), Value::Object(specification));
    let mut choices = Map::new();
    choices.insert("status".into(), Value::from("reviewed"));
    if let Some(items) = saved.get("choices") {
        choices.insert("items".into(), items.clone());
    }
    card.insert("choices".into(), Value::Object(choices));
    let mut lifecycle = Map::new();
    lifecycle.insert("status".into(), Value::from("reviewed"));
    if let Some(stages) = saved.get("lifecycle") {
        lifecycle.insert("stages".into(), stages.clone());
    }
    card.insert("lifecycle".into(), Value::Object(lifecycle));
    card.insert("remaining".into(), json!([]));
    set_nested(card, "dependencies", "status", Value::from("verified"));
    let runs = array(record.get("runs"));
    let scenarios: Vec<Value> = scenario_triples(&COMMON_SCENARIOS)
        .into_iter()
        .chain(scenario_triples(&BASIC_SCENARIOS))
        .map(|(id, dimension, description)| {
            let saved_scenario = array(saved.get("scenarios")).iter().find(|scenario| is_str(scenario.get("id"), &id));
            let evidence: Vec<Value> = array(saved_scenario.and_then(|scenario| scenario.get("runIds")))
                .iter()
                .map(|run_id| evidence_entry(find_run(runs, Some(run_id)), record, inspection, BASIC_SPELL_EVIDENCE_PATH, "basic-spell-dependencies/v1"))
                .collect();
            json!({ "id": id, "dimension": dimension, "description": description, "status": "passed", "evidence": evidence })
        })
        .collect();
    card.insert("scenarios".into(), Value::Array(scenarios));
    card.insert("readiness".into(), Value::Object(SPELL_ACCEPTANCE_DIMENSIONS.iter().map(|dimension| (dimension.to_string(), Value::from("verified"))).collect()));
    set_nested(card, "implementation", "executionVerified", Value::Bool(true));
    set_nested(card, "availability", "actorEligibilityChecked", Value::Bool(true));
    card.insert("accepted".into(), Value::Bool(true));
}

fn inspect_longstrider_evidence(record: Option<&Value>, fingerprints: &Map<String, Value>) -> Value {
    let record = defined(record);
    let mut result = inspection_base(LONGSTRIDER_EVIDENCE_PATH, record, fingerprints);
    let Some(record) = record else {
        return Value::Object(result);
    };
    let field = |key: &str| prop(Some(record), key);
    if !is_str(field("schemaVersion"), "spell-evidence/v1") || !is_str(field("spellId"), "longstrider") || !(is_str(field("status"), "pending") || is_str(field("status"), "recorded")) {
        result.insert("status".into(), Value::from("invalid"));
        push_problem(&mut result, "Нужен spell-evidence/v1 только для longstrider со статусом pending или recorded.");
        return Value::Object(result);
    }
    if is_str(field("status"), "pending") {
        return with_status(&result, "pending", None);
    }
    if !is_revision(field("testedRevision")) || !date_is_valid(field("observedAt")) {
        push_problem(&mut result, "Нужны фактический implementation commit и дата прогона.");
    }
    if !recorded_keys_match(field("dependencyFingerprints"), &LONGSTRIDER_EVIDENCE_DEPENDENCIES, fingerprints) {
        result.insert("status".into(), Value::from("stale"));
        push_problem(&mut result, "Отпечатки зависимостей отсутствуют или расходятся с текущими файлами; требуется повторный прогон.");
        return Value::Object(result);
    }
    let runs = array(field("runs"));
    let mut run_ids: Vec<Option<&Value>> = Vec::new();
    for run in runs {
        let run = Some(run);
        let id = prop(run, "id");
        let kind_ok = is_str(prop(run, "kind"), "test-run") || is_str(prop(run, "kind"), "manual-run");
        let status_ok = is_str(prop(run, "status"), "pending") || is_str(prop(run, "status"), "passed");
        if !truthy(id) || run_ids.iter().any(|known| jsv::strict_eq(*known, id)) || !kind_ok || !status_ok {
            push_problem(&mut result, "У каждого прогона нужны уникальный ID, вид и явный результат.");
        }
        if !run_ids.iter().any(|known| jsv::strict_eq(*known, id)) {
            run_ids.push(id);
        }
        if is_str(prop(run, "status"), "passed")
            && (!truthy(prop(run, "command")) || !receipt_reference_ok(run) || !truthy(jsv::path(run, &["receipt", "artifact"])) || !is_sha256(jsv::path(run, &["receipt", "sha256"])))
        {
            push_problem(&mut result, "Пройденный запуск требует команды, отчёта для PR и SHA-256 исходного лога; список тестовых файлов не является результатом.");
        }
    }
    if !runs.iter().any(|run| is_str(prop(Some(run), "kind"), "test-run") && is_str(prop(Some(run), "status"), "passed") && is_str(prop(Some(run), "command"), "pnpm verify")) {
        push_problem(&mut result, "Итоговый pnpm verify должен иметь отдельную успешную запись.");
    }
    let pilot_scenarios = array(pilot("longstrider").and_then(|pilot| pilot.get("scenarios"))).to_vec();
    let expected: Vec<(String, String, String)> = scenario_triples(&COMMON_SCENARIOS).into_iter().chain(scenario_triples(&pilot_scenarios)).collect();
    let scenarios = array(field("scenarios"));
    let scenario_ids: Vec<Option<&Value>> = scenarios.iter().map(|scenario| prop(Some(scenario), "id")).collect();
    if scenarios.len() != expected.len() || distinct_count(&scenario_ids) != expected.len() {
        push_problem(&mut result, "Нужен точный набор сценариев longstrider без удаления и дубликатов.");
    }
    for (id, dimension, _) in &expected {
        let scenario = scenarios.iter().find(|candidate| is_str(prop(Some(candidate), "id"), id));
        let Some(scenario) = scenario.filter(|scenario| {
            (is_str(scenario.get("status"), "pending") || is_str(scenario.get("status"), "passed")) && scenario.get("runIds").is_some_and(Value::is_array)
        }) else {
            push_problem(&mut result, &format!("Некорректен сценарий {id}."));
            continue;
        };
        let evidence_runs: Vec<Option<&Value>> = array(scenario.get("runIds")).iter().map(|run_id| find_run(runs, Some(run_id))).collect();
        let passed = is_str(scenario.get("status"), "passed");
        if passed && (evidence_runs.is_empty() || evidence_runs.iter().any(|run| !is_str(prop(*run, "status"), "passed"))) {
            push_problem(&mut result, &format!("Сценарий {id} не привязан к успешному прогону."));
        }
        let has_manual = evidence_runs.iter().any(|run| is_str(prop(*run, "kind"), "manual-run"));
        if passed && dimension == "presentation" && !has_manual {
            push_problem(&mut result, "Представление требует ручной приёмки двух игроков; unit/API-проверки её не заменяют.");
        }
        if passed && id == "normal-acquisition-and-cast" && !has_manual {
            push_problem(&mut result, "Основной HTTP/UI-путь требует ручной проверки сайта в дополнение к HTTP-сценарию.");
        }
    }
    let invalid = !array(result.get("problems")).is_empty();
    with_status(&result, if invalid { "invalid" } else { "current" }, None)
}

fn apply_longstrider_evidence(card: &mut Map<String, Value>, record: &Value, inspection: &Value) {
    card.insert("evidenceRecord".into(), inspection.clone());
    if !is_str(inspection.get("status"), "current") {
        return;
    }
    let runs = array(record.get("runs"));
    if let Some(Value::Array(scenarios)) = card.get_mut("scenarios") {
        for scenario in scenarios.iter_mut() {
            let Some(recorded) = array(record.get("scenarios")).iter().find(|candidate| jsv::strict_eq(candidate.get("id"), scenario.get("id"))) else {
                continue;
            };
            if !is_str(recorded.get("status"), "passed") {
                continue;
            }
            let evidence: Vec<Value> = array(recorded.get("runIds"))
                .iter()
                .map(|run_id| evidence_entry(find_run(runs, Some(run_id)), record, inspection, LONGSTRIDER_EVIDENCE_PATH, "longstrider-dependencies/v1"))
                .collect();
            if let Some(map) = scenario.as_object_mut() {
                map.insert("status".into(), Value::from("passed"));
                map.insert("evidence".into(), Value::Array(evidence));
            }
        }
    }
    let scenarios = array(card.get("scenarios")).to_vec();
    for dimension in SPELL_ACCEPTANCE_DIMENSIONS {
        let verified = scenarios.iter().filter(|scenario| is_str(scenario.get("dimension"), dimension)).all(|scenario| is_str(scenario.get("status"), "passed"));
        set_nested(card, "readiness", dimension, Value::from(if verified { "verified" } else { "pending" }));
    }
    let rules = is_str(jsv::path(card.get("readiness"), &["rules"]), "verified");
    let player_path = is_str(jsv::path(card.get("readiness"), &["playerPath"]), "verified");
    set_nested(card, "implementation", "executionVerified", Value::Bool(rules));
    set_nested(card, "availability", "actorEligibilityChecked", Value::Bool(player_path));
}

/// Вывод `git` в каталоге; `None` — команда не запустилась, упала или
/// превысила предел буфера (как `execFileSync` с `maxBuffer`).
fn git(root: &Path, args: &[&str], max_buffer: usize) -> Option<String> {
    let output = Command::new("git").args(args).current_dir(root).output().ok()?;
    if !output.status.success() || output.stdout.len() > max_buffer {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Статусы каталога в исходной ревизии (`git show`); без истории — явная
/// недоступность. История нужна только аудиту.
pub fn read_spell_acceptance_baseline(repository_root: &Path) -> Value {
    let available = || -> Option<Value> {
        let catalog_text = git(repository_root, &["show", &format!("{SPELL_ACCEPTANCE_BASELINE}:{CATALOG_PATH}")], 8 * 1024 * 1024)?;
        let overrides_text = git(repository_root, &["show", &format!("{SPELL_ACCEPTANCE_BASELINE}:{OVERRIDES_PATH}")], 8 * 1024 * 1024)?;
        let catalog: Value = serde_json::from_str(&catalog_text).ok()?;
        let overrides: Value = serde_json::from_str(&overrides_text).ok()?;
        let overrides = jsv::js_ordered_deep(overrides);
        let overrides = defined(overrides.get("spells")).cloned().unwrap_or_else(|| json!({}));
        let spells = catalog.get("spells").and_then(Value::as_array)?;
        let mut statuses = Map::new();
        for spell in spells {
            let id = jsv::string(spell.get("id"));
            let entry = prop(Some(&overrides), &id);
            let status = match defined(prop(entry, "mechanicsSupport")) {
                Some(status) => status.clone(),
                None => Value::from(if js::truthy(entry) { "partial" } else { "heuristic" }),
            };
            statuses.insert(id, status);
        }
        Some(json!({
            "status": "available",
            "commit": SPELL_ACCEPTANCE_BASELINE,
            "statuses": Value::Object(jsv::js_ordered(statuses)),
            "catalogSha256": sha256(&catalog_text),
            "overridesSha256": sha256(&overrides_text),
        }))
    };
    available().unwrap_or_else(|| {
        json!({
            "status": "unavailable",
            "commit": SPELL_ACCEPTANCE_BASELINE,
            "statuses": null,
            "reason": "В этой копии нет исходного коммита: поимённые исходные группы не подтверждены. Аудит текущего каталога доступен.",
        })
    })
}

fn current_revision(root: &Path) -> Option<String> {
    git(root, &["rev-parse", "HEAD"], 1024 * 1024).map(|text| text::trim(&text).to_string())
}

fn working_tree_snapshot(root: &Path, revision: Option<&str>) -> Option<String> {
    let revision = revision?;
    let limit = 32 * 1024 * 1024;
    let diff = git(root, &["diff", "--no-ext-diff", "--binary", "HEAD"], limit)?;
    let listing = git(root, &["ls-files", "-z", "--others", "--exclude-standard"], limit)?;
    let mut untracked: Vec<&str> = listing.split('\0').filter(|path| !path.is_empty()).collect();
    untracked.sort_by_key(|path| path.encode_utf16().collect::<Vec<u16>>());
    let mut files = Vec::new();
    for path in untracked {
        let bytes = std::fs::read(root.join(path)).ok()?;
        files.push(json!([path, sha256_hex(&bytes)]));
    }
    Some(sha256(&jsv::stringify(&json!({ "revision": revision, "diffSha256": sha256(&diff), "untracked": files }))))
}

fn dependency_candidates(spell: &Value) -> Vec<String> {
    let mut items: Vec<&str> = vec!["spell-acquisition", "target-validation", "resource-selection", "component-contract"];
    if js::truthy(spell.get("concentration")) {
        items.push("concentration");
    }
    if is_str(spell.get("actionType"), "long_cast") {
        items.push("long-casting-phases");
    }
    if js::truthy(spell.get("radius")) {
        items.push("area-geometry");
    }
    if is_str(spell.get("kind"), "healing") {
        items.push("healing-and-target-types");
    }
    if is_str(spell.get("kind"), "summon") {
        items.push("summon-lifecycle");
    }
    if jsv::length(spell.get("conditions")).is_some_and(|length| length > 0) {
        items.push("condition-lifecycle");
    }
    items.into_iter().map(str::to_string).collect::<IndexSet<_>>().into_iter().collect()
}

fn problem(id: Option<&Value>, code: &str, message: &str) -> Value {
    json!({ "id": id.cloned().unwrap_or(Value::Null), "code": code, "message": message })
}

fn evidence_backed_by_receipt(evidence: Option<&Value>, card: &Value, scope: &str, reference: &str, dependencies: &[&str]) -> bool {
    let record = card.get("evidenceRecord");
    let fingerprints = prop(record, "dependencyFingerprints");
    is_str(prop(evidence, "scope"), scope)
        && is_str(prop(record, "status"), "current")
        && is_str(prop(evidence, "recordReference"), reference)
        && dependencies.iter().all(|path| is_sha256(prop(fingerprints, path)))
        && object_entries(defined(fingerprints)).len() == dependencies.len()
        && is_str(prop(evidence, "dependencySha256"), &dependency_digest(fingerprints))
        && is_revision(prop(evidence, "testedRevision"))
        && jsv::strict_eq(prop(evidence, "testedRevision"), prop(record, "testedRevision"))
        && is_sha256(prop(evidence, "receiptSha256"))
        && truthy(prop(evidence, "command"))
        && truthy(prop(evidence, "artifact"))
}

/// Схема аудита не принимает заявления о готовности без привязанных
/// доказательств: список нарушений `{ id, code, message }`.
pub fn validate_spell_acceptance_report(report: &Value) -> Vec<Value> {
    let mut problems: Vec<Value> = Vec::new();
    let Some(spells) = report.get("spells").and_then(Value::as_array).filter(|_| is_str(report.get("schemaVersion"), "spell-acceptance/v1")) else {
        return vec![problem(None, "INVALID_SCHEMA", "Ожидается spell-acceptance/v1 с массивом spells.")];
    };
    let mut add = |id: Option<&Value>, code: &str, message: &str| problems.push(problem(id, code, message));
    let baseline_status = jsv::path(Some(report), &["baseline", "status"]);
    if !(is_str(baseline_status, "available") || is_str(baseline_status, "unavailable")) || !is_str(jsv::path(Some(report), &["baseline", "commit"]), SPELL_ACCEPTANCE_BASELINE) {
        add(None, "INVALID_BASELINE", "Нужна исходная ревизия и явная доступность истории.");
    }
    let mut ids: Vec<Option<&Value>> = Vec::new();
    for card in spells {
        if !card.is_object() {
            add(None, "INVALID_CARD", "Паспорт должен быть объектом.");
            continue;
        }
        let field = |key: &str| card.get(key);
        let id = field("spellId");
        if !id.is_some_and(|id| id.as_str().is_some_and(|id| !id.is_empty())) || ids.iter().any(|known| jsv::strict_eq(*known, id)) {
            add(id, "INVALID_SPELL_ID", "ID должен быть непустым и уникальным.");
        }
        if !ids.iter().any(|known| jsv::strict_eq(*known, id)) {
            ids.push(id);
        }
        let id_text = id.and_then(Value::as_str);
        if !id_text.is_some_and(|id| CATALOG_IDS.contains(id)) {
            add(id, "UNKNOWN_SPELL_ID", "ID отсутствует в рабочем каталоге.");
        }
        let level = field("level");
        let level_ok = level.and_then(Value::as_f64).is_some_and(|level| level.fract() == 0.0 && (0.0..=6.0).contains(&level));
        if !level_ok || !field("name").and_then(Value::as_str).is_some_and(|name| !name.is_empty()) {
            add(id, "INVALID_IDENTITY", "Нужны название и круг от 0 до 6.");
        }
        let support = jsv::path(Some(card), &["availability", "supportStatus"]);
        let support_text = support.and_then(Value::as_str);
        if !support_text.is_some_and(|status| SUPPORT_STATUSES.contains(&status)) {
            add(id, "INVALID_SUPPORT_STATUS", "Неизвестный статус доступности.");
        }
        let blocked_expected = support_text.is_some_and(|status| BLOCKED_STATUSES.contains(&status));
        if !jsv::strict_eq(jsv::path(Some(card), &["availability", "blocked"]), Some(&Value::Bool(blocked_expected))) {
            add(id, "AVAILABILITY_MISMATCH", "Блокировка расходится с контрактом каталога.");
        }
        let initial = jsv::path(Some(card), &["baseline", "supportStatus"]);
        let initial_text = initial.and_then(Value::as_str);
        let initial_is_null = matches!(initial, Some(Value::Null));
        if !initial_is_null && !initial_text.is_some_and(|status| SUPPORT_STATUSES.contains(&status)) {
            add(id, "INVALID_BASELINE_STATUS", "Недопустимая исходная группа.");
        }
        let expected_group = if !js::present(initial) {
            Value::Null
        } else if initial_text.is_some_and(|status| BLOCKED_STATUSES.contains(&status)) {
            Value::from("blocked")
        } else {
            initial.cloned().unwrap_or(Value::Null)
        };
        if !jsv::strict_eq(jsv::path(Some(card), &["baseline", "group"]), Some(&expected_group)) {
            add(id, "BASELINE_GROUP_MISMATCH", "Исходная группа расходится с исходным статусом.");
        }
        if is_str(baseline_status, "unavailable") && !initial_is_null {
            add(id, "UNPROVEN_BASELINE", "Без истории нельзя восстановить исходный статус из текущего.");
        }
        if !is_sha256(jsv::path(Some(card), &["source", "cardSha256"])) || !is_str(jsv::path(Some(card), &["source", "rulesetId"]), "dnd_5e_2014") {
            add(id, "INVALID_SOURCE", "Нужны хеш исходной карточки и закреплённый ruleset.");
        }
        let specification_status = jsv::path(Some(card), &["specification", "status"]);
        if !["inventory-only", "pilot-draft", "reviewed"].iter().any(|status| is_str(specification_status, status)) {
            add(id, "INVALID_SPECIFICATION", "Неизвестный уровень спецификации.");
        }
        let remaining_is_array = field("remaining").is_some_and(Value::is_array);
        let remaining_length = jsv::length(field("remaining")).unwrap_or(0);
        let accepted = truthy(field("accepted"));
        let items = jsv::path(Some(card), &["dependencies", "items"]);
        if !remaining_is_array || (!accepted && remaining_length == 0) || !items.is_some_and(Value::is_array) || array(items).is_empty() {
            add(id, "MISSING_REMAINDER", "Нужны остаток и зависимости, включая ещё не проверенные.");
        }
        if accepted && (remaining_length > 0 || !is_str(jsv::path(Some(card), &["dependencies", "status"]), "verified")) {
            add(id, "UNRESOLVED_ACCEPTED_CARD", "Принятая карточка не может иметь незакрытый остаток или непроверенные зависимости.");
        }
        let scenarios = array(field("scenarios"));
        let pilot_scenarios = id_text.and_then(pilot).map(|pilot| array(pilot.get("scenarios")).to_vec()).unwrap_or_default();
        let required: Vec<(String, String, String)> = scenario_triples(&COMMON_SCENARIOS).into_iter().chain(scenario_triples(&pilot_scenarios)).collect();
        for (required_id, required_dimension, _) in &required {
            let scenario = scenarios.iter().find(|candidate| is_str(prop(Some(candidate), "id"), required_id));
            match scenario {
                Some(scenario) if is_str(scenario.get("dimension"), required_dimension) => {
                    if is_str(scenario.get("status"), "not-applicable") {
                        add(id, "REQUIRED_SCENARIO_NOT_APPLICABLE", &format!("Обязательный сценарий {required_id} нельзя исключить из приёмки."));
                    }
                }
                _ => add(id, "MISSING_REQUIRED_SCENARIO", &format!("Обязательный сценарий {required_id} нельзя удалить или перенести в другое измерение.")),
            }
        }
        let mut scenario_ids: Vec<Option<&Value>> = Vec::new();
        for scenario in scenarios {
            if !scenario.is_object() {
                add(id, "INVALID_SCENARIO", "Сценарий должен быть объектом.");
                continue;
            }
            let scenario_field = |key: &str| scenario.get(key);
            let scenario_id = scenario_field("id");
            let dimension_ok = SPELL_ACCEPTANCE_DIMENSIONS.iter().any(|dimension| is_str(scenario_field("dimension"), dimension));
            if !truthy(scenario_id) || scenario_ids.iter().any(|known| jsv::strict_eq(*known, scenario_id)) || !dimension_ok || !truthy(scenario_field("description")) {
                add(id, "INVALID_SCENARIO", "У сценария нужны уникальный ID, измерение и описание.");
            }
            if !scenario_ids.iter().any(|known| jsv::strict_eq(*known, scenario_id)) {
                scenario_ids.push(scenario_id);
            }
            let status = scenario_field("status");
            if !["pending", "passed", "not-applicable"].iter().any(|candidate| is_str(status, candidate)) {
                add(id, "INVALID_SCENARIO_STATUS", "Неизвестный статус сценария.");
            }
            if is_str(status, "not-applicable") && !truthy(scenario_field("reason")) {
                add(id, "MISSING_NOT_APPLICABLE_REASON", "Неприменимость требует объяснения для конкретного ID.");
            }
            let evidence = scenario_field("evidence");
            if !evidence.is_some_and(Value::is_array) {
                add(id, "INVALID_EVIDENCE", "Доказательства должны быть массивом.");
            }
            if is_str(status, "passed") && !jsv::length(evidence).is_some_and(|length| length > 0) {
                add(id, "UNPROVEN_SCENARIO", "Пройденный сценарий требует доказательств.");
            }
            for entry in array(evidence) {
                let entry = Some(entry);
                let basic = evidence_backed_by_receipt(entry, card, "basic-spell-dependencies/v1", BASIC_SPELL_EVIDENCE_PATH, &BASIC_SPELL_EVIDENCE_DEPENDENCIES);
                let longstrider = id_text == Some("longstrider") && evidence_backed_by_receipt(entry, card, "longstrider-dependencies/v1", LONGSTRIDER_EVIDENCE_PATH, &LONGSTRIDER_EVIDENCE_DEPENDENCIES);
                let tree = truthy(report.get("workingTreeSha256")) && jsv::strict_eq(prop(entry, "treeSha256"), report.get("workingTreeSha256"));
                let kind_ok = is_str(prop(entry, "kind"), "test-run") || is_str(prop(entry, "kind"), "manual-run");
                if !truthy(entry) || !kind_ok || !truthy(prop(entry, "reference")) || !date_is_valid(prop(entry, "observedAt")) || !(longstrider || basic || tree) {
                    add(id, "INVALID_EVIDENCE", "Нужны вид, ссылка, дата и совпадающий хеш дерева либо актуальный receipt зависимостей.");
                }
            }
            if is_str(status, "passed") && is_str(scenario_field("dimension"), "presentation") && !array(evidence).iter().any(|entry| is_str(prop(Some(entry), "kind"), "manual-run")) {
                add(id, "MISSING_MANUAL_EVIDENCE", "Представление подтверждается ручной приёмкой, не автоматическим тестом.");
            }
        }
        for dimension in SPELL_ACCEPTANCE_DIMENSIONS {
            let relevant: Vec<&Value> = scenarios.iter().filter(|scenario| is_str(prop(Some(scenario), "dimension"), dimension)).collect();
            let actual = jsv::path(Some(card), &["readiness", dimension]);
            let complete = !relevant.is_empty() && relevant.iter().all(|scenario| is_str(scenario.get("status"), "passed") || is_str(scenario.get("status"), "not-applicable"));
            if relevant.is_empty() || !is_str(actual, if complete { "verified" } else { "pending" }) {
                add(id, "READINESS_MISMATCH", &format!("Измерение {dimension} не подтверждено сценариями."));
            }
        }
        let all_verified = SPELL_ACCEPTANCE_DIMENSIONS.iter().all(|dimension| is_str(jsv::path(Some(card), &["readiness", dimension]), "verified"));
        let unproven = !jsv::strict_eq(field("accepted"), Some(&Value::Bool(all_verified)))
            || (accepted
                && (truthy(jsv::path(Some(card), &["availability", "blocked"]))
                    || !is_str(specification_status, "reviewed")
                    || !js::is_true(jsv::path(Some(card), &["specification", "individuallyReviewed"]))
                    || !truthy(jsv::path(Some(card), &["source", "publication"]))
                    || !truthy(jsv::path(Some(card), &["source", "acceptedRevision"]))));
        if unproven {
            add(id, "UNPROVEN_ACCEPTANCE", "Полная приёмка требует всех измерений, поимённой спецификации, публикации, сверенной ревизии и доступного пути.");
        }
    }
    if spells.len() != 439 || ids.len() != 439 {
        add(None, "CATALOG_SCOPE_MISMATCH", "Эта очередь приёмки охватывает ровно 439 уникальных ID кругов 0–6.");
    }
    let accepted = spells.iter().filter(|card| js::is_true(card.get("accepted"))).count();
    let summary_accepted = jsv::path(Some(report), &["summary", "accepted"]);
    let summary_catalog = jsv::path(Some(report), &["summary", "catalog"]);
    if !jsv::is_num(summary_accepted, accepted as f64) || !jsv::is_num(summary_catalog, spells.len() as f64) {
        add(None, "SUMMARY_MISMATCH", "Сводка должна считаться из паспортов, а не задаваться вручную.");
    }
    problems
}

/// Входы аудита приёмки: `None` — прочитать по умолчанию (JS: параметр не
/// передан), `Some(Value::Null)` — явный `null`.
#[derive(Clone, Debug, Default)]
pub struct SpellAcceptanceOptions {
    pub baseline: Option<Value>,
    pub longstrider_evidence: Option<Value>,
    pub basic_evidence: Option<Value>,
}

fn count_by(values: impl IntoIterator<Item = String>) -> Value {
    let mut counts = Map::new();
    for key in values {
        let current = counts.get(&key).and_then(Value::as_i64).unwrap_or(0);
        counts.insert(key, Value::from(current + 1));
    }
    Value::Object(jsv::js_ordered(counts))
}

const SOURCE_NOTE: &str = "Хеш фиксирует локальный текст; редакция публикации и исключения требуют поимённой сверки. Правила профиля не доказывают происхождение каждой карточки.";
const PROFILE_FIELDS: [&str; 10] = ["target", "range", "radius", "damage", "healing", "saveAbility", "maxTargets", "concentration", "durationRounds", "actionType"];

fn royalty(component: &Value) -> bool {
    is_str(component.get("kind"), "royalty")
}

fn acceptance_card(raw: &Value, spell: &Value, baseline: &Value) -> Map<String, Value> {
    let id = js::s(raw.get("id"));
    let pilot = pilot(&id);
    let pilot_field = |key: &str| pilot.and_then(|pilot| pilot.get(key));
    let initial = defined(jsv::path(baseline.get("statuses"), &[id.as_str()])).cloned().unwrap_or(Value::Null);
    let initial_text = initial.as_str();
    let group = if initial.is_null() {
        Value::Null
    } else if initial_text.is_some_and(|status| BLOCKED_STATUSES.contains(&status)) {
        Value::from("blocked")
    } else {
        initial.clone()
    };
    let support = spell.get("mechanicsSupport");
    let blocked = support.and_then(Value::as_str).is_some_and(|status| BLOCKED_STATUSES.contains(&status));
    let components = spell.get("components");
    let mut component_dependencies: Vec<String> = Vec::new();
    if truthy(jsv::path(components, &["material", "unresolved"])) {
        component_dependencies.push("unresolved-material-requirement".into());
    }
    if array(jsv::path(components, &["special"])).iter().any(royalty) {
        component_dependencies.push("royalty-payment".into());
    }
    let mut card = Map::new();
    card.insert("spellId".into(), raw.get("id").cloned().unwrap_or(Value::Null));
    for key in ["name", "englishName", "level"] {
        if let Some(value) = spell.get(key) {
            card.insert(key.into(), value.clone());
        }
    }
    card.insert("baseline".into(), json!({ "supportStatus": initial, "group": group }));
    let mut availability = Map::new();
    if let Some(support) = support {
        availability.insert("supportStatus".into(), support.clone());
    }
    availability.insert("blocked".into(), Value::Bool(blocked));
    availability.insert("actorEligibilityChecked".into(), Value::Bool(false));
    card.insert("availability".into(), Value::Object(availability));
    let mut source = Map::new();
    source.insert("rulesetId".into(), Value::from("dnd_5e_2014"));
    if let Some(url) = raw.get("sourceUrl") {
        source.insert("url".into(), url.clone());
    }
    source.insert("publication".into(), defined(pilot_field("publication")).cloned().unwrap_or(Value::Null));
    source.insert("acceptedRevision".into(), Value::Null);
    source.insert("reviewReferences".into(), defined(pilot_field("reviewReferences")).cloned().unwrap_or_else(|| json!([])));
    source.insert("cardSha256".into(), Value::from(sha256(&jsv::stringify(raw))));
    source.insert("runtimeCardSha256".into(), Value::from(sha256(&jsv::stringify(spell))));
    source.insert("note".into(), Value::from(SOURCE_NOTE));
    card.insert("source".into(), Value::Object(source));
    let mut implementation = Map::new();
    implementation.insert("owner".into(), Value::from("server/rules-engine.mjs"));
    implementation.insert("command".into(), Value::from("CastSpell"));
    implementation.insert("catalogOwner".into(), Value::from("server/combat-spells.mjs"));
    if let Some(kind) = spell.get("kind") {
        implementation.insert("kind".into(), kind.clone());
    }
    implementation.insert("supportNote".into(), defined(spell.get("supportNote")).cloned().unwrap_or(Value::Null));
    implementation.insert("executionVerified".into(), Value::Bool(false));
    implementation.insert(
        "profile".into(),
        Value::Object(PROFILE_FIELDS.iter().map(|key| (key.to_string(), defined(spell.get(*key)).cloned().unwrap_or(Value::Null))).collect()),
    );
    card.insert("implementation".into(), Value::Object(implementation));
    card.insert(
        "specification".into(),
        json!({ "status": if pilot.is_some() { "pilot-draft" } else { "inventory-only" }, "individuallyReviewed": false, "detailedReference": if pilot.is_some() { Value::from("docs/spell-pilot-acceptance.md") } else { Value::Null } }),
    );
    let mut items: Vec<String> = match pilot_field("dependencies") {
        Some(dependencies) => array(Some(dependencies)).iter().map(|item| js::s(Some(item))).collect(),
        None => dependency_candidates(spell),
    };
    items.extend(component_dependencies);
    let items: Vec<String> = items.into_iter().collect::<IndexSet<_>>().into_iter().collect();
    card.insert("dependencies".into(), json!({ "status": if pilot.is_some() { "planned" } else { "candidates" }, "items": items }));
    card.insert("componentRequirements".into(), defined(components).cloned().unwrap_or(Value::Null));
    card.insert("choices".into(), json!({ "status": if pilot.is_some() { "planned" } else { "unreviewed" }, "items": defined(pilot_field("choices")).cloned().unwrap_or_else(|| json!([])) }));
    card.insert("lifecycle".into(), json!({ "status": if pilot.is_some() { "planned" } else { "unreviewed" }, "stages": defined(pilot_field("lifecycle")).cloned().unwrap_or_else(|| json!([])) }));
    let mut remaining: Vec<Value> = Vec::new();
    if truthy(spell.get("supportNote")) {
        remaining.push(spell["supportNote"].clone());
    }
    if truthy(pilot_field("remainder")) {
        remaining.push(pilot_field("remainder").cloned().unwrap_or(Value::Null));
    }
    if blocked {
        remaining.push(Value::from("Применение заблокировано; наличие вида карточки не подтверждает обработчик конкретного эффекта."));
    }
    remaining.push(Value::from(if pilot.is_some() {
        "Индивидуальные сценарии пилота ещё требуют доказательств по окончательному дереву."
    } else {
        "Поимённая спецификация остатка и опасных взаимодействий ещё не проведена; общие кандидаты не заменяют её."
    }));
    card.insert("remaining".into(), Value::Array(remaining));
    let pilot_scenarios = array(pilot_field("scenarios")).to_vec();
    let scenarios: Vec<Value> = scenario_triples(&COMMON_SCENARIOS)
        .into_iter()
        .chain(scenario_triples(&pilot_scenarios))
        .map(|(id, dimension, description)| json!({ "id": id, "dimension": dimension, "description": description, "status": "pending", "evidence": [] }))
        .collect();
    card.insert("scenarios".into(), Value::Array(scenarios));
    card.insert("readiness".into(), Value::Object(SPELL_ACCEPTANCE_DIMENSIONS.iter().map(|dimension| (dimension.to_string(), Value::from("pending"))).collect()));
    card.insert("accepted".into(), Value::Bool(false));
    card
}

/// Read-only проекция единственного рабочего каталога; проверку игры этот
/// отчёт не заменяет. Ошибка — не прочитался обязательный файл репозитория.
pub fn audit_spell_acceptance(options: SpellAcceptanceOptions) -> Result<Value, String> {
    audit_spell_acceptance_in(&repository_root(), options)
}

/// [`audit_spell_acceptance`] для явного корня репозитория.
pub fn audit_spell_acceptance_in(root: &Path, options: SpellAcceptanceOptions) -> Result<Value, String> {
    let baseline = options.baseline.unwrap_or_else(|| read_spell_acceptance_baseline(root));
    let longstrider_evidence = options.longstrider_evidence.unwrap_or_else(|| read_longstrider_evidence(root));
    let basic_evidence = options.basic_evidence.unwrap_or_else(|| read_basic_spell_evidence(root));
    let catalog_text = read(root, CATALOG_PATH).map_err(|error| error.message)?;
    let catalog: Value = jsv::js_ordered_deep(serde_json::from_str(&catalog_text).map_err(|error| error.to_string())?);
    let mut fingerprints = Map::new();
    for path in [CATALOG_PATH, OVERRIDES_PATH, "server/combat-spells.mjs", "server/rules-engine.mjs", "data/rule_packs/dnd_5e_2014/manifest.yaml", "server/spell-acceptance-audit.mjs"] {
        let text = read(root, path).map_err(|error| error.message)?;
        fingerprints.insert(path.into(), Value::from(sha256(&text)));
    }
    let longstrider_inspection = inspect_longstrider_evidence(Some(&longstrider_evidence), &longstrider_dependency_fingerprints(root)?);
    let options_2014 = json!({ "rulesetId": "dnd_5e_2014" });
    let raw_spells = array(catalog.get("spells"));
    let basic_ids: Vec<String> = raw_spells
        .iter()
        .filter(|raw| canonical_combat_spell_for(raw.get("id"), Some(&options_2014)).is_some_and(|spell| is_str(spell.get("mechanicsSupport"), "verified")))
        .map(|raw| jsv::string(raw.get("id")))
        .collect();
    let basic_inspection = inspect_basic_spell_evidence(Some(&basic_evidence), &basic_spell_dependency_fingerprints(root)?, &basic_ids, &catalog);
    let mut spells: Vec<Value> = Vec::new();
    for raw in raw_spells {
        let spell = canonical_combat_spell_for(raw.get("id"), Some(&options_2014)).ok_or_else(|| format!("Нет карточки {}", jsv::string(raw.get("id"))))?;
        let mut card = acceptance_card(raw, &spell, &baseline);
        let id = jsv::string(raw.get("id"));
        if id == "longstrider" {
            apply_longstrider_evidence(&mut card, &longstrider_evidence, &longstrider_inspection);
        }
        if basic_ids.contains(&id) {
            apply_basic_spell_evidence(&mut card, &basic_evidence, &basic_inspection);
        }
        spells.push(Value::Object(card));
    }
    let statuses = defined(baseline.get("statuses")).cloned();
    let mut baseline_info = baseline.as_object().cloned().unwrap_or_default();
    baseline_info.shift_remove("statuses");
    let initial_counts = statuses.as_ref().map(|statuses| count_by(object_entries(Some(statuses)).into_iter().map(|(_, status)| jsv::string(Some(&status)))));
    let revision = current_revision(root);
    let tree = working_tree_snapshot(root, revision.as_deref());
    let requirements = |spell: &Value| spell.get("componentRequirements").cloned();
    let unresolved_material: Vec<Value> = spells
        .iter()
        .filter(|spell| truthy(jsv::path(spell.get("componentRequirements"), &["material", "unresolved"])))
        .map(|spell| {
            let mut entry = Map::new();
            entry.insert("spellId".into(), spell.get("spellId").cloned().unwrap_or(Value::Null));
            jsv::spread_into(&mut entry, jsv::path(requirements(spell).as_ref(), &["material"]));
            Value::Object(entry)
        })
        .collect();
    let royalties: Vec<Value> = spells
        .iter()
        .filter(|spell| array(jsv::path(spell.get("componentRequirements"), &["special"])).iter().any(royalty))
        .map(|spell| {
            let special: Vec<Value> = array(jsv::path(spell.get("componentRequirements"), &["special"])).iter().filter(|component| royalty(component)).cloned().collect();
            json!({ "spellId": spell.get("spellId"), "requirements": special })
        })
        .collect();
    let mut baseline_value = baseline_info;
    baseline_value.insert("counts".into(), initial_counts.clone().unwrap_or(Value::Null));
    baseline_value.insert("expectedCounts".into(), json!({ "heuristic": 191, "ruling-only": 8, "partial": 240 }));
    let string_of = |spell: &Value, keys: &[&str]| jsv::string(jsv::path(Some(spell), keys));
    let summary = json!({
        "catalog": spells.len(),
        "support": count_by(spells.iter().map(|spell| string_of(spell, &["availability", "supportStatus"]))),
        "initialGroups": count_by(spells.iter().map(|spell| match defined(jsv::path(Some(spell), &["baseline", "group"])) {
            Some(group) => jsv::string(Some(group)),
            None => "unavailable".to_string(),
        })),
        "blocked": spells.iter().filter(|spell| truthy(jsv::path(Some(spell), &["availability", "blocked"]))).count(),
        "accepted": spells.iter().filter(|spell| truthy(spell.get("accepted"))).count(),
        "specifications": count_by(spells.iter().map(|spell| string_of(spell, &["specification", "status"]))),
        "components": {
            "material": spells.iter().filter(|spell| truthy(jsv::path(spell.get("componentRequirements"), &["material"]))).count(),
            "unresolvedMaterialIds": unresolved_material.iter().map(|entry| entry.get("spellId").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(),
            "royaltyIds": royalties.iter().map(|entry| entry.get("spellId").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(),
        },
    });
    let mut warnings: Vec<Value> = Vec::new();
    if is_str(baseline.get("status"), "unavailable") {
        warnings.push(baseline.get("reason").cloned().unwrap_or(Value::Null));
    }
    for inspection in [&longstrider_inspection, &basic_inspection] {
        if is_str(inspection.get("status"), "stale") || is_str(inspection.get("status"), "invalid") {
            warnings.extend(array(inspection.get("problems")).iter().cloned());
        }
    }
    let mut report = Map::new();
    report.insert("schemaVersion".into(), Value::from("spell-acceptance/v1"));
    report.insert("auditScope".into(), Value::from("inventory-and-checklist"));
    report.insert("revision".into(), revision.clone().map_or(Value::Null, Value::from));
    report.insert("workingTreeSha256".into(), tree.map_or(Value::Null, Value::from));
    report.insert("fingerprints".into(), Value::Object(fingerprints));
    report.insert("baseline".into(), Value::Object(baseline_value));
    report.insert("summary".into(), summary);
    report.insert("componentGaps".into(), json!({ "unresolvedMaterial": unresolved_material, "royalties": royalties }));
    let mut longstrider_summary = Map::new();
    longstrider_summary.insert("reference".into(), Value::from(LONGSTRIDER_EVIDENCE_PATH));
    for key in ["status", "testedRevision", "dependencySha256"] {
        if let Some(value) = longstrider_inspection.get(key) {
            longstrider_summary.insert(key.into(), value.clone());
        }
    }
    let mut basic_summary = Map::new();
    basic_summary.insert("reference".into(), Value::from(BASIC_SPELL_EVIDENCE_PATH));
    for key in ["status", "dependencySha256"] {
        if let Some(value) = basic_inspection.get(key) {
            basic_summary.insert(key.into(), value.clone());
        }
    }
    report.insert("evidence".into(), json!({ "basicSpells": Value::Object(basic_summary), "longstrider": Value::Object(longstrider_summary) }));
    report.insert("warnings".into(), Value::Array(warnings));
    report.insert("spells".into(), Value::Array(spells));
    let report = Value::Object(report);
    let mut problems = validate_spell_acceptance_report(&report);
    let joined = |inspection: &Value| array(inspection.get("problems")).iter().map(|entry| jsv::string(Some(entry))).collect::<Vec<_>>().join(" ");
    if is_str(longstrider_inspection.get("status"), "invalid") {
        problems.push(json!({ "id": "longstrider", "code": "INVALID_PERSISTED_EVIDENCE", "message": joined(&longstrider_inspection) }));
    }
    if is_str(basic_inspection.get("status"), "invalid") {
        problems.push(json!({ "id": null, "code": "INVALID_BASIC_SPELL_EVIDENCE", "message": joined(&basic_inspection) }));
    }
    if let (Some(statuses), Some(counts)) = (&statuses, &initial_counts) {
        let count = |key: &str| counts.get(key).cloned();
        let mismatch = object_entries(Some(statuses)).len() != 439
            || !jsv::strict_eq(count("heuristic").as_ref(), Some(&Value::from(191)))
            || !jsv::strict_eq(count("ruling-only").as_ref(), Some(&Value::from(8)))
            || !jsv::strict_eq(count("partial").as_ref(), Some(&Value::from(240)));
        if mismatch {
            problems.push(json!({ "id": null, "code": "BASELINE_COUNTS_MISMATCH", "message": "Исходная ревизия не подтверждает группы 191 heuristic, 8 ruling-only, 240 partial." }));
        }
        let spells = array(report.get("spells"));
        let missing = spells.iter().any(|spell| !statuses.as_object().is_some_and(|map| map.contains_key(&jsv::string(spell.get("spellId")))));
        if missing {
            problems.push(json!({ "id": null, "code": "BASELINE_IDS_MISMATCH", "message": "Набор текущих ID расходится с исходной ревизией." }));
        }
    }
    let mut result = Map::new();
    result.insert("ok".into(), Value::Bool(problems.is_empty()));
    if let Value::Object(report) = report {
        for (key, value) in report {
            result.insert(key, value);
        }
    }
    result.insert("problems".into(), Value::Array(problems));
    Ok(Value::Object(result))
}

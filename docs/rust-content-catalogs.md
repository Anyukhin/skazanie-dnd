# Каталоги контента Rust-сервера

Опись каталогов, которые читает `skazanie-server`, и их проверки (урок 7 плана
переноса, `docs/rust-rewrite-plan.md` §1 п.7). Правило: каталог встроен в
сборку и разбирается один раз; модуль-владелец держит в `LazyLock` результат
разбора (`Result<_, ContentError>`, `sk_core::content`), отдаёт проверку
функцией `check_…`, а разбор — функцией от строки, чтобы тесты проверяли
сломанные копии, не трогая `data/`. Сервер до приёма запросов прогоняет все
проверки (`sk_server::content_check`): ошибка данных — отказ старта с именем
файла и записи и кодом 1. Та же проверка — `skazanie-server check-content`
(0 — чисто, 1 — ошибки, 2 — неверные аргументы; `--data-dir`, `--json`).

До урока каталоги разбирались лениво, при первом обращении: битый JSON или
запись давали панику посреди первого запроса, который тронул каталог, 500
этого запроса (миры) или молча пустой каталог (предыстории, происхождение,
атласы, строки TaleSpire). JS разбирал их при загрузке модулей, то есть при
старте (битый JSON — отказ старта), а сценарий, диалоги, карты мест и миры
там же и проверял.

## Проверяемые каталоги

«Новое» — проверка, которой до урока в Rust не было.

| Файл | Крейт, модуль | Представление | Что проверяется | Как грузился до урока |
| --- | --- | --- | --- | --- |
| `data/campaign-scenarios-v1.json` | `sk-scenario` `campaign_scenario` | `Vec<Value>` | перенос `validateScenario` JS: версия схемы, id, места, тайны, узлы, условия, рыцарь, внимание, развязки, один сценарий на мир | `LazyLock`, паника |
| `data/campaign-dialogues-v1.json` | `sk-story` `campaign_dialogues` | типы `Dialogue`, `DialogueOption` (`normalize_dialogues`) | версия, id, `scenario_id`/`npc_id`, приветствие, варианты, проверки, флаги | `LazyLock`, паника |
| `data/authored-location-maps-v1.json` | `sk-map-core` `authored_location_maps` | `IndexMap<id, Value>` (сериализованная карта) | версия, id места, маркер `tilesetId`, `validate_tactical_map` | `LazyLock`, паника |
| `data/campaign-worlds-v1.json` | `sk-world-time` `world_template_catalog` | `Vec<Value>` | перенос проверки JS: четыре шаблона, граф карты мира, NPC, картинки в `public/` корня данных | `LazyLock<Result>`, 500 запроса |
| `data/backgrounds-srd-5-2-1.json`, `data/backgrounds-dnd-5e-2014.json` | `sk-ruleset` `backgrounds` | `Value` | новое: схема, `rulesetId`, `id` (уникален) и `name` предыстории, группа инструментов есть в `toolChoiceGroups` | `LazyLock`, битый JSON — молча `null` |
| `data/character-creation-policy-v1.json`, `data/character-creation-dnd-5e-2014.json` | `sk-ruleset` `character_creation_catalog` | `Value` | `assertPolicy` JS (было только в тестах); новое: `ruleset_id`, `id` видов и профилей прибавок, группы выбора вида — id уникален, варианты в группе или в `choice_catalogs`, не меньше `count` | `LazyLock`, битый JSON — молча `null` |
| `data/dndsu-class-build-rules-1-12.json` + `data/character-rules-manifest.json` | `sk-ruleset` `character_progression` | `Catalog` (индексы над `Value`) | сверка с манифестом — хеш, размер, предельный уровень (было только в тестах); новое: `id` и `ability` навыков, `classKey` классов, `id` групп выбора | `LazyLock`, битый JSON — молча `null` |
| `data/starter-equipment-dnd-5e-2014.json` | `sk-chargen` `starter_kit` | `Value` | новое: версия 2, редакция, `class_id` и `background_id` профилей, группы выбора и варианты; `dynamic_source` — известный источник (иначе выбор молча пуст) | `LazyLock`, паника |
| `data/starter-item-presentation.json` | `sk-chargen` `starter_kit` | `Value` | новое: версия, `items` — объект «имя → оформление» | `LazyLock`, паника |
| `rust/data/condition-effects.json` | `sk-rules` `tables` | `Value` | новое: эффект — объект, поля только из словаря движка и своего вида (опечатку движок молча не видит) | `OnceLock`, паника |
| `rust/data/item-catalog.json` | `sk-rules` `tables` | `Value` | новое: `catalog_id` совпадает с ключом, есть `name` | `OnceLock`, паника |
| `data/asset-rights.json`, `public/assets/maps/props/prop-atlas.json`, `public/assets/maps/detail-v1/prop-atlas.json` | `sk-scene-base` `asset_registry` | `PropAtlas`, `HashSet` путей | новое (только проверка, чтение терпимо, как в JS): у атласа есть картинка и кадры, у кадра — числа `x`, `y`, `w`, `h` (кадр без предмета в реестре — норма набора детализации), пути прав без повторов, права на картинки атласов зарегистрированы | терпимо: битый — пустой атлас |
| `data/talespire-assets-v1.json` | `sk-talespire` `talespire_import` | `HashMap<GUID, AssetRow>` | версия; новое: каждая строка — `[t\|p, роль, 6 чисел, материал, вид, жанр f\|s?]` (иначе молча выпадала) | `LazyLock<Result>`, отказ импорта |
| `data/compendia/dnd_5e_2014/*` (14 файлов) | `sk-combat-base` `dndsu_2014_content` | `Value` | перенос `loadDndsu2014Content`: хеши манифеста, источники, записи бестиария, предметов и правил | `include_bytes!`, `LazyLock<Result>` |
| `data/dndsu-class-actions-1-12.json` | `sk-combat-content` `combat_actions` | `Value` | разбор JSON; механику разбирает урок 8 | `LazyLock`, паника — теперь отказ проверки с именем файла |
| `data/dndsu-spells-0-6.json`, `data/dndsu-spell-mechanics-overrides.json` | `sk-combat-content` `combat_spells` | `Value` | разбор JSON и сборка карточек; урок 8 | то же |
| `data/compendia/dnd_5e_2014/monsters.json` | `sk-combat-content` `wild_shape` | `Vec<WildShapeForm>` | каждый зверь списка есть в бестиарии; урок 8 | то же |
| `data/rule_packs/{srd_5_2_1,dnd_5e_2014}/*` | `sk-rulepack` `rule_pack` | `Value` | `validateRulePack` JS | чтение с диска корня данных при открытии состояния (`RuleCatalog::load`) — как было; теперь ещё и в проверке до приёма запросов и в `check-content`, отказ называет пакет |
| — (каталог в коде) | `sk-items` `item_catalog` | `Value` | сборка из таблиц кода; урок 8 | `LazyLock`, форсируется |

## Что не проверяется и почему

| Файл | Где | Почему |
| --- | --- | --- |
| `public/assets/models/environment/manifest.json` | `sk-scene-base` `environment_catalog_revision` | читается с диска на ходу с кэшем по подписи файла и меняется без пересборки; нет файла — норма (старый каталог `pr79`) |
| `crates/sk-encounters/src/srd_5_2_1_monsters.json` | `sk-encounters` `encounter_assembler` | перенос литерала JS (код, не `data/`); сторож — эталон `fixtures/encounter-assembler.json` |
| `prompts/**` | `sk-agents` | тексты ролей модели — слой агентов, не контент ядра |
| `data/content-provenance.json`, `data/rules-coverage-matrix.json` | `sk-items-life` `content_integrity` | перенос `pnpm content:verify` (гейт выпуска); сервер его не зовёт |
| `data/spell-descriptions-ru.json`, `data/ruleset-cutover-2014.json`, `data/authored-location-layouts-*.json`, `data/authored-tactical-ares-v1.json`, `data/authored-location-overview-manifest-v1.json`, `data/authored-maps/` | — | Rust-сервер их не читает (инструменты JS и клиент) |
| `<storage>/map-library` | `sk-story` `map_library` | данные пользователя, не контент сборки |

## Сценарий: `Value`, а не тип `serde`

Сценарий оставлен `Value` с проверкой (`parse_scenario_catalog`). Части
карточек и узлов уходят в состояние кампании и в рассказ как есть
(`spread_copy`, `insert_raw`) — с неизвестными полями и порядком ключей файла,
а проверка — построчный перенос `validateScenario` JS с его текстами отказов,
которые сверяет эталон `validation_matches_js`. Тип со своим разбором дал бы
другие тексты отказов на тех же сломанных данных и терял бы поля, которые
копируются в состояние без чтения.

## Как добавить каталог

1. В модуле-владельце: путь файла константой, `pub fn parse_…(text) ->
   ContentResult<…>` с проверкой ключевых полей (`sk_core::content`:
   `keyed_records`, `required_str`, `schema_version`), `LazyLock` с результатом
   и `pub fn check_…()`.
2. Тест на копию с опечаткой в ключевом поле: отказ называет файл и запись.
3. Строка в `catalogs()` (`rust/crates/sk-server/src/content_check.rs`) и в
   этой описи; `sk-server/tests/content_check.rs` проверяет, что файл в списке.

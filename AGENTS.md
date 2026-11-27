# Работа в репозитории «Сказание»

Операционные правила для агентов и разработчиков: **как** менять код. Цель
продукта и требования к ИИ-ведущему — `docs/product-principles.md`; история и
обоснования прежних решений — `docs/agents-history.md`.

---

## 1. Стек и жёсткие технические факты

Нарушение любого пункта ломает сборку или тесты.

- **Сервер игры — Rust** (`rust/`, Cargo workspace, бинарь `skazanie-server`).
  С 2026-11-27 он единственный сервер и эталон поведения; правила работы —
  `rust/AGENTS.md`. Прежний JS-сервер — `archive/js-server/`: история, не
  запускается; рабочее состояние — коммит, названный в его `README.md`.
- **`server/` — замороженная JS-библиотека** (ESM `.mjs`): правила, карты и
  каталоги, которые читают клиент (`src/`), инструменты контента (`tools/`),
  стенды (`eval/`) и контрактные тесты (сборка состояний). Сервером не
  запускается. Новое поведение игры — только в `rust/`; `server/` правится,
  лишь если этого требует клиент или инструмент, и тогда то же поведение — в
  Rust. Не создавать `server/*.ts`. Подробно — `server/README.md`.
- **`src/` — TypeScript + React + Vite**, проверка `tsc --noEmit -p tsconfig.app.json`.
- **Тесты JS — встроенный `node:test`, файлы `test/*.test.mjs`**: модульные
  (`pnpm test`) и контракт HTTP против бинаря Rust (`test/contract-rust.list`,
  `pnpm test:contract`). Тесты сервера — `cargo test` в `rust/`. Jest, Vitest
  и Playwright в проекте нет; браузерный сценарий проверяется вручную.
- Node `>=20.19.0`, пакетный менеджер **pnpm**; Rust stable, на Windows —
  GNU-toolchain с MinGW (`rust/PORTING.md` §6), сборка только `--release`.
- Хранилище — SQLite `skazanie.sqlite` в `DND_STORAGE_DIR`; у игры владельца —
  том Docker `skazanie-rust_storage`. Отдельного сервера БД нет. Прежнее
  файловое `storage/` JS — только источник разового переноса
  (`tools/rust-cutover.ps1`).
- Версии в `package.json` — `^X.Y.Z`, совпадающие с `pnpm-lock.yaml`; менять
  только вместе с локом. Новые зависимости разрешены (решение владельца
  2026-10-13); в Rust — фиксировать в `Cargo.lock`.

## 2. Команды

```bash
pnpm dev              # vite :4173 + Rust-сервер :8788 (tmp/rust-play/storage)
pnpm dev:client       # только vite; прокси — на AGENT_PORT (по умолчанию 8787)
pnpm rust:play        # только Rust-сервер: :8788, своё хранилище; --offline — без модели
                      # (игра владельца — Rust в Docker на 8787, START_DND.cmd)

pnpm test                              # модульные тесты JS, затем бюджет tactical-map отдельно
node --test test/<файл>.test.mjs       # один файл — так проверять точечные правки
pnpm test:contract    # контракт HTTP против Rust; бинарь с --features test-hooks —
                      # в SKAZANIE_RUST_SERVER_BIN (rust/AGENTS.md §4)
pnpm build            # tsc --noEmit + vite build
pnpm verify           # test + build; вместе с контрактом и cargo test всё гоняет CI
                      # (.github/workflows/verify.yml, rust.yml)
cargo test --release -p sk-<крейт>     # из rust/: тесты крейта; остальное — rust/AGENTS.md §4

pnpm content:verify   # целостность контента и лицензий
pnpm spells:verify    # override заклинаний против каталога dnd.su;
                      # обязательно после правки data/dndsu-spell-mechanics-overrides.json
skazanie-server check-content          # каталоги data/ так, как их проверяет сервер при старте
skazanie-server audit-storage --storage <каталог>  # журнал против replay; только чтение
node tools/build-ascii-location-maps.mjs --all --check  # нарисованные карты мест
                      # (data/authored-maps/), без --check — запись в каталог
pnpm maps:preview     # карта текстом без кампании: --location, --theme, --seed;
                      # --preset all --audit — генераторы JS-библиотеки; карты игры
                      # строит Rust, их сторож — cargo test -p sk-map-core и sk-settlements
pnpm models:scale     # рост предметов и фигурок в футах против нормы D&D по корпусу
                      # карт; после правки каталога моделей, пределов высоты или роста
pnpm props:atlas      # атлас предметов: --sheets assets-src/prop-stamps, затем pnpm props:rights
pnpm terrain:tiles    # фактуры пола и стен из assets-src/floor-wall-stamps, затем pnpm terrain:rights
pnpm talespire:assets # таблица ассетов TaleSpire (--dir или TALESPIRE_DIR)
pnpm backup           # зашифрованная копия файлового storage прежнего JS-сервера в ./backups;
                      # нужен DND_BACKUP_KEY. Подкоманды бэкапа базы Rust пока нет
                      # (docs/audit-2026-11-27-plan.md)
```

`*:rights` пишут хеши в `data/asset-rights.json` — без них `content:verify`
падает на дрейфе. Порт и хост — `AGENT_PORT` / `AGENT_HOST` (`8787` / `0.0.0.0`).

## 3. Секреты и данные

- **`.env` разрешено читать и править** (разрешение владельца от 2026-07-25);
  он в `.gitignore` и не коммитится. Новые переменные — и в `.env.example`, с
  комментарием и без значения.
- **Значения секретов не выводить** — ни в логи, ни в тесты, ни в коммиты, ни в
  ответ. Проверять наличие и формат `ROUTERAI_API_KEY` можно, печатать — нет:
  вывод остаётся в транскриптах. Показать ключ целиком может только владелец.
- **`storage/` и том `skazanie-rust_storage` — рабочие данные пользователя.**
  Тесты используют временный каталог; хранилища, `data/` и сгенерированный
  контент не править без явной задачи.
- Не удалять и не переписывать чужие изменения в dirty worktree.

## 4. Карта кода

Прежде чем добавлять модуль, найти существующего владельца задачи. **Второго
авторитетного пути быть не должно:** создание кампании, загрузка, действия
игроков, ходы NPC и автономный Director идут через один Rules Engine.

**Каталоги:** `rust/` — сервер: механика, оркестрация, хранение (крейты —
`rust/AGENTS.md` §3); `src/` — интерфейс; `prompts/` — версионированные
контракты агентов; `test/` — проверки клиента и контракт HTTP; `docs/` —
архитектура, покрытие, ограничения; `tools/` — аудиты и обслуживание;
`server/` — замороженная JS-библиотека; `archive/js-server/` — прежний
JS-сервер, его тесты и инструменты.

**Имена модулей ниже — по JS.** Rust-модуль повторяет модуль JS по смыслу
имени (`server/npc-social.mjs` → крейт `sk-social`, модуль `npc_social`), а его
`//!`-шапка называет перенесённый файл. Поведение правится в Rust-модуле;
одноимённый `server/*.mjs`, если он не ушёл в `archive/js-server/server/`, —
замороженная копия для клиента и инструментов. Слои крейтов без циклов держит
`sk-server/tests/crate_layers.rs`.

**Ядро (единственные источники истины):**

| Файл | Ответственность |
| --- | --- |
| `server/rules-engine.mjs` | вся механика, допустимость, числа; точка входа для любого правила |
| `server/event-store.mjs` | события, commit, replay |
| `server/dice-service.mjs` | вся случайность; в тестах внедряется детерминированно |
| `server/roll-registry.mjs` | `roll_id`/`check_id`, срок действия, защита от повторного применения |
| `server/game-orchestrator.mjs` | оркестрация цикла `/api/narrate` |
| `server/index.mjs` | HTTP-сервер и маршруты (в Rust — `sk-server`, таблица маршрутов в порядке JS) |
| `server/store.mjs` | persistence (в Rust — `sk-store`, SQLite) |
| `server/security.mjs` | членство, владелец героя, полномочия |
| `server/viewer-projection.mjs` | что игрок имеет право видеть |

**Агентные роли.** Клиенты модели собираются только в `sk-server` (`main.rs` и
тестовый набор) и уже обёрнутыми в учёт расхода попадают в `AppState`;
остальные крейты получают клиент внедрением. Ядро не зависит от `sk-agents`
(`rust/AGENTS.md` §2). Привязки промптов (роли — в `sk-agents`):

| Файл | Промпт | Роль |
| --- | --- | --- |
| `server/director-agent.mjs` | `prompts/director/v4_story.txt`, `v4_chaos.txt` | темп, развилки, переходы; вариант по `improv_mode` в `choose()` |
| `server/npc-controller.mjs` | `prompts/npc_controller/v1.txt` | мораль и перелом боя NPC |
| `server/npc-social-controller.mjs` | `prompts/npc_controller/social_v8.txt` | социальные сцены; зацепки карты о собеседнике (`public_hooks_naming_npc`), встречные зацепки (`leads`), карточка героя (`speaking_hero`), антиповтор (`already_said`) |
| `server/narrator.mjs` | `prompts/narrator/v14.txt` | текст после commit, живой ответ на слова и поступки игрока; якоря карты (`landmarks`, `landmarks_absent`); сюжет сценария (`scenario`) |
| `server/scene-architect.mjs` | `prompts/map_architect/v8.txt` | новые области, заготовки (`secrets`), якоря (`map.design.landmarks`) |
| `server/campaign-bootstrap.mjs` | `prompts/campaign_creator/v8.txt` | исходная ситуация, заготовки (`secrets`), якоря первой карты |
| `server/action-adjudicator.mjs` | `prompts/action_adjudicator/v10.txt` | прочтение свободного действия, маршрут (`check`/`travel`/`talk`/`clarify`) и деталь успеха (`success_detail`) |
| `server/campaign-recap.mjs` | `prompts/recap/v1.txt` | рекап «в прошлой серии» |
| `server/lore-voice.mjs` | `prompts/lore_keeper/v2.txt` | порядок известных сведений в ответе «что мы знаем». Текст свидетельства и имя говорящего берутся из материала `answerKnownLore` |
| `server/hero-hooks.mjs` | `prompts/hero_hooks/v1.txt` | зацепки из предысторий героев: скрытые `gm_secret` с `hero_id`, личная нить; стадия `hero-hooks` после коммита |

Других загрузок промптов нет. Остальные файлы в `prompts/` — прежние версии тех
же контрактов и few-shot, оставлены как история. Реестр загрузок —
`sk-narration-base` `prompt_descriptors` (`loaded_prompt_ids`).

**Детерминированные модули без LLM** — не называть их «агентами»:
`adjudicator`, `intent-parser`, `world-memory`, `projection-integrity`,
`npc-turn-scheduler`, `campaign-loop-policy`, `world-deeds`, `captives`,
`parley`, `law-and-order`, `scene-requirements`, `scene-program-layout`,
`map-quality`, `weather`, `offscreen-world`, `loot-containers`, `tavern-life`,
`courier-letters`, `talespire-slab`, `talespire-import`, `map-library`,
`thin-walls`, `room-floors`, `detail-props`, `scene-features`, `scene-dressing`,
`reaction-preferences`, `campaign-scenario`, `scenario-attention`, `scenario-knight`, `combat-phrases`.

**Маршрутизация ввода:** `server/player-request-router.mjs` объявляет
`PLAYER_REQUEST_ROLES`. `prompt_id` там — метаданные, а не привязка: его не
читает ни один модуль, он стоит только у ролей, исполняемых моделью (строка или
список вариантов). `worldkeeper` (детерминированный `answerKnownLore`) и
`game_master` (Rules Engine) — без `prompt_id`. Сторож —
`sk-agents` `player_request_router` (`tests/a2_semantics.rs`). Материал хранителя отбирает
`answerKnownLore`. Модель `lore_keeper/v2` предлагает порядок ссылок,
`lore-voice` проверяет их и собирает текст. При ошибке игрок видит исходную сводку.

**Сценарий авторской кампании:** `campaign-scenario` читает
`data/campaign-scenarios-v1.json` (сюжет для людей — `docs/astohan-scenario.md`).
Карточку места накладывает `AdvanceScene`, прогресс сюжета, развязка и
открытие карты выводятся из состояния — отдельных событий у сценария нет.
Политика Режиссёра (`campaign-loop-policy`) берёт из него фазу, следующее место
и встречу; кампании без сценария живут по вечерней арке. Счётчик внимания
главного противника и сцену незнакомца ведёт `scenario-attention` (реестр
`scenario_attention` в редьюсере, команда `StageScenarioStranger`); проклятого
рыцаря, который приходит только в своё окно ночи, — `scenario-knight`.

**Автономный цикл:** `director-agent` (решение модели) → `autonomous-campaign`
(контракт намерения, `DIRECTOR_INTENT_TYPES`) → `autonomous-orchestrator`
(исполнение) → `campaign-loop-policy` (запасной путь без модели).
`adventure-director.mjs` — не режиссёр, а слой локаций сцены (память карт,
генерация геометрии, `createSceneTransition`); логику режиссёра туда не класть.

**Готовые карты (TaleSpire):** `talespire-slab` разбирает слэб,
`talespire-import` проецирует его на этажи и комнаты, `map-library` хранит
библиотеку в `<storage>/map-library` и подбирает постройку в
`generateSceneGeometryFor` (`adventure-director.mjs`). Команда ведущего —
`ImportLocationMap`, маршрут — `sk-server` (`routes`).

**Домен NPC (не путать):**

- `npc-social.mjs` — профили, обещания, отношения и граница знания NPC
  (`npcKnownFactIds`: своё, публичное, увиденное самим NPC, заготовки, где он
  хранитель); `npc-social-check.mjs` — навыковые проверки;
- `npc-turn-scheduler.mjs` — детерминированная боевая политика NPC;
- `npc-controller.mjs` (`NpcMoraleAgent`) — только мораль и перелом боя: вне
  момента морали `decide()` возвращает `null`;
- `captives.mjs` — пленные после сдачи и нелетального нокаута, СЛ допроса, пощада;
- `law-and-order.mjs` — розыск и стража. **Лист:** ничего из сервера не
  импортирует, иначе замкнётся кольцо через `reputation-policy`;
- `tavern-life.mjs` — досуг заведения; игроки за столом выводятся из сида и не
  хранятся; импортирует только `npc-positioning.mjs`;
- `courier-letters.mjs` — почта отряда; время тикает в
  `appendWorldTimeConsequences`, модель пишет только слова ответа при отправке
  (`withCourierReplyDraft`);
- `creative-director.mjs` (`CriticalNarrationCoordinator`) — только текст
  критического момента после commit, механики не касается.

**Жизнь вещи:** `item-catalog.mjs` — общий тип; `item-instances.mjs` — конкретная
вещь с историей и снимком каталога; `loot-containers.mjs` — контейнер выбывшего
хозяина, рождается в том же коммите, инвентарь переезжает в него, `LootContainer`
переносит набор целиком или никак. `loot-tables.mjs` и `encounter-rewards.mjs` —
награда за встречу, с телами не связаны.

**Рассказчики `*-narration`** регистрируются по контракту
`server/deterministic-narration.mjs` (`id`, числовой `priority`, `promptVersion`,
`provider`, `matches`, `narrate`). `combat-narration.mjs` следует контракту, но
в реестр намеренно не входит.

## 5. Инварианты и их сторожа

При изменении механики запускать соответствующий тест точечно: тест крейта
(`cargo test --release -p <крейт> --test <файл>`) или контрактный файл
(`node --test test/<файл>.test.mjs` с `SKAZANIE_RUST_SERVER_BIN`). Новые
контрактные тесты писать на общем наборе `test/kit/` (сервер с админом и
игроками, кубики, заглушка модели, сборка клиентского TS) — как, описано в
`docs/testing.md`; новые тесты механики — в крейте, который её владеет. Свои
копии `startServer`, `dice()` и `applyAll` не заводить. Контракт — файлы
`test/contract-rust.list`; крейты — `rust/crates/<крейт>/tests/`.

| Инвариант | Сторож |
| --- | --- |
| Replay потока событий даёт то же состояние | `sk-store/tests/event_store.rs`, `sk-rules/tests/replay_corpus.rs`, `skazanie-server audit-storage` (`sk-server/tests/storage_audit.rs`) |
| Потеря хвоста журнала или seed-снимка — явный отказ `CAMPAIGN_RECOVERY_REQUIRED`, а не тихая загрузка старого состояния; отказ одной кампании не роняет сервер | `sk-server/tests/server_c1.rs`, `journal_cli.rs`, контракт `recovery-required-api` |
| Повтор с тем же `idempotency_key` возвращает прежний commit; другая цель, тип команды, актор или endpoint под тем же ключом — `409 IDEMPOTENCY_CONFLICT` | контракт `api-integration`, `command-retry-intent-api`; `sk-orchestrator/tests/game_semantics.rs` |
| Все броски серверные, один бросок не применяется дважды; механическая проверка принимает только кость своей карточки | `sk-dice`, `sk-infra/tests/roll_registry.rs`, `sk-rules/tests/dice_pause.rs`, контракт `roll-binding` |
| Клиентские поля недоверенные (путь, дальность, цель) | `sk-server/tests/command_guard.rs`, `test/tactical-command-guard.test.mjs` |
| Права, членство и владелец героя проверяются сервером | `sk-tactics/tests/security.rs` |
| Готового героя игрок не переписывает импортом; новый герой создаётся только с полным набором выборов первого уровня, в 2014 — с `phbCreation` | `sk-character/tests/character_lifecycle.rs`, `sk-heroes/tests/character_creation_phb.rs` |
| Игрок видит только разрешённое, в том числе в уже открытом живом потоке после logout, истечения сессии и смены доступа; прогноз удара не выдаёт закрытую КД процентом попадания | `sk-projection/tests/viewer_projection.rs`, `p1.rs`, `sk-tactics/tests/combat_forecast_disclosure.rs`, контракт `viewer-projection-api`, `stream-live-access-api` |
| Рассказчик не создаёт событий и не объявляет смерть | `sk-agents/tests/a5_semantics.rs` |
| NPC знает только своё, публичное и увиденное им самим; повтор своей реплики вырезается сервером; отказ ведёт к зацепке, а не в тупик | `sk-social/tests/npc_social_behaviour.rs`, `sk-agents/tests/a4_semantics.rs` |
| Зацепки из предыстории плетутся один раз на героя путём заготовок ведущего, Режиссёр видит мотивы без текста зацепок; replay сходится — **частично**: отдельного теста replay в Rust нет (план) | `sk-agents/tests/a2_semantics.rs`, `sk-society/tests/post_commit_coordinator.rs` |
| Летопись хода не пропадает на устаревшей проекции: слова игрока, строка хода и критическая реплика рассказчика идут по порядку до автохода врага и переживают перезапуск | контракт `combat-journal-order-api` |
| Сгенерированная карта играбельна: дверь наружу, окна, комнаты, досягаемость, мебель не в проёмах и не за краем | `sk-map-core/tests/map_quality.rs` |
| Карта держит программу сцены: центр, посты и улики на месте и досягаемы; библиотечная карта без них не выбирается; двадцать мест корпуса строятся без замечаний | `sk-settlements/tests/scene_program_layout.rs`, `sk-story/tests/map_library.rs`, `sk-director/tests/fixtures.rs` (корпус `test/fixtures/scene-programs/corpus.json`) |
| В поселении у каждой двери дома есть дорога, на тропе ничего не стоит; отряд входит со стороны, откуда пришёл, а центр сцены стоит на площади | `sk-settlements/tests/settlement_generator.rs` (`DOOR_OFF_ROAD`, `PATH_BLOCKED`), `sk-director/tests/fixtures.rs` |
| Рассказчик не описывает то, что сцена обещала, а карта не держит | `sk-agents/tests/a5_semantics.rs` (`ABSENT_LANDMARK_MENTIONED`) |
| Команда факта, убеждения или слуха проходит, только если предикат есть в онтологии мира для этого вида записи и подлежащего; replay старых событий словарь не проверяет | `sk-memory/tests/world_ontology_write.rs`, `sk-society/tests/world_ontology.rs` |
| Перестройка карты — только ведущему; та же схема события, что у импорта. Отказы в бою, при голосовании и открытой проверке и replay перестройки — **без теста в Rust** (план) | контракт `map-import-api` |
| Враг встречи появляется по эту сторону дверей и окон от отряда | `sk-encounters/tests/encounter_assembler.rs` |
| Параллельные команды не перезаписывают друг друга молча | контракт `narrate-room-version-race`; `sk-rules/tests/skeleton.rs` (`expected_state_version`) |
| Корпус тестов не ходит в интернет: каждый запуск сервера — с пустым `ROUTERAI_API_KEY` или локальным `ROUTERAI_BASE_URL` | контракт `test-network-isolation`, `sk-server/tests/config_isolation.rs` |
| Запрос не роняет сервер: тело — только JSON-объект, необработанная ошибка маршрута завершает свой запрос ответом 500 | контракт `map-import-api`, `recovery-required-api` |
| Весь вызов модели и картинок идёт через учёт расхода; известный usage непригодного ответа тоже записывается | `sk-infra/tests/usage_ledger.rs`, контракт `item-images-api` |
| Медленный читатель живого потока не копит кадры: комната и присутствие схлопываются до последнего состояния, очередь соединения ограничена, отзыв прав уходит напрямую | `sk-infra/tests/narration_stream.rs`, контракт `stream-backpressure-api` |
| Библиотечная постройка выбирается, только если исправны все её этажи. Карта читается только той, на которую указывает её хеш, — **без теста в Rust** (план) | `sk-story/tests/map_library.rs` |
| Бэкап не снимается с работающего на том же storage сервера без явного `--allow-live` | `sk-infra/tests/backup_service.rs`, контракт `storage-backup-cli` |
| Кампания по сценарию идёт по его узлам, финал — исход боя с главным противником в логове; развязка переживает replay — **частично** (план) | `sk-scenario/tests/campaign_scenario.rs` |
| Внимание главного противника — вывод из журнала, игроку не видно; незнакомца ставит и раскрывает только сервер, выдох — серверными бросками; засаду и внезапность финала решает счёт, а не Режиссёр | `sk-attention/tests/scenario_attention.rs` |

Если новый инвариант нельзя привязать к тесту — он ещё не инвариант, а намерение.
Пробелы, помеченные «план», — в `docs/audit-2026-11-27-plan.md` (волна «Rust-only, этап 2»).

## 6. Порядок реализации механики

1. Серверная **команда** → **правило** в Rules Engine → **событие** → **reducer**.
2. Только затем проекция, промпт и UI.
3. Prompt или React-компонент **не компенсируют** отсутствующее доменное правило.
4. Тесты на: успех, отказ, права, идемпотентность, replay. Случайность —
   через внедрённый детерминированный Dice Service.
5. Схемы событий и контракты промптов **версионировать**. Сохранённые кампании и
   старый replay не ломать без явной миграции: версия схемы снимка и цепочка
   `sk_rules::schema::migrations` (`rust/AGENTS.md` §2).
6. Поведение игры меняется только в `rust/`. Правка `server/` в игру не
   попадает: это замороженная библиотека клиента и инструментов (§1).

**Статусы механики** (карточки заклинаний и действий, см. `docs/known-limitations.md`):

- `verified` — есть серверный handler, события, тесты replay/idempotency;
- `partial` — исполняется безопасная часть, ограничение описано в UI;
- `heuristic` / `ruling-only` — **блокируется** и клиентом, и Rules Engine до
  расхода ресурсов или экономики хода.

Приблизительный ответ LLM вместо правила не является реализацией. Если правило
не поддержано — запросить уточнение, применить явно отмеченный ruling или честно
сообщить об ограничении.

**Когда звать LLM.** Перемещения, атаки, магия, торговля, инициатива и
стандартные ходы NPC — **только сервер, без модели**. Модель — там, где нужна
новая творческая информация: исходная ситуация кампании, новая область, перелом
боя и мораль, действительно нестандартное свободное действие. Расход — через
учёт `sk-infra` `usage_ledger`. Не добавлять вызов LLM в горячий путь хода.

## 7. Язык

- Интерфейс, повествование, документация, комментарии — **русский**.
- Идентификаторы, имена файлов, команды, события, поля API, `rule_id` — **английский**.
- Промпты — русский текст с английскими именами инструментов и полей.

## 8. Критерий готовности

Применять по типу изменения.

**Механика, команда, событие, правило — все семь пунктов:**

1. действие доступно реальному игроку через основной сайт;
2. механика проверяется и рассчитывается сервером;
3. результат сохранён событиями, идемпотентен, совпадает после replay/restart;
4. права, visibility и недоверенные клиентские поля проверены;
5. Рассказчик описывает только подтверждённый результат;
6. есть тесты штатного пути и существенных отказов;
7. документация отражает реальное покрытие и оставшиеся ограничения.

**Изменение UI:** пункты 1, 4, 5 + `pnpm build` + проверка реального HTTP-пути
+ ручная проверка основного браузерного сценария с двумя игроками.

**Документация, тексты, стили:** достаточно точности утверждений.

При изменении фактических возможностей обновлять `README.md` и
`docs/rules-coverage.md` либо `docs/known-limitations.md`. **Не заявлять
нереализованную полноту** — это нарушение, равное сломанному тесту.

## 9. Приоритет при конфликте требований

`безопасность и целостность данных → серверный авторитет → закреплённый ruleset →
свобода и непрерывность кампании → художественное и визуальное качество`.

**Остановиться и спросить пользователя**, если задача требует: миграции или
удаления данных в `storage/` или тома `skazanie-rust_storage`, возврата
JS-сервера из архива (сыгранное на Rust назад не переносится) или повторного
переноса настоящего `storage/`, изменения схемы событий без обратной совместимости,
ослабления любого инварианта из раздела 5 или отступления от
`docs/product-principles.md`.

## 10. Совместная работа

- Работать можно в текущем каталоге; отдельный worktree — по необходимости задачи.
- Перед изменениями проверить ветку и состояние дерева; чужие правки сохранять,
  при пересечении уточнить порядок работы.
- В индекс добавлять только файлы своей задачи перечислением; перед коммитом
  проверить ветку и итоговый diff.
- Независимые задачи — параллельно, с разделёнными областями правок; итоговые
  проверки — после всех правок задачи. Тестовые серверы — на отдельных портах и
  временном хранилище.

## 11. Основной репозиторий и публикационная копия

| Репозиторий | Что в нём |
| --- | --- |
| `Anyukhin/skazanie-dnd` — **основной** | вся разработка, PR и полная история |
| `Anyukhin/skazanie` — публикационная копия | только текущее состояние, история с чистого листа |

Разработка, push и PR — в основном: ветки от `main`, возврат через PR.
Публичный обновляется **только по отдельному запросу**: переносится состояние
(`git archive`), а не коммиты, и только через PR с зелёной `verify`. Порядок,
причина отдельной истории и проверки перед переносом — `docs/public-mirror.md`.

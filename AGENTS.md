# Работа в репозитории «Сказание»

Операционные правила для агентов и разработчиков: **как** менять код. Цель
продукта и требования к ИИ-ведущему — `docs/product-principles.md`; история и
обоснования прежних решений — `docs/agents-history.md`.

---

## 1. Стек и жёсткие технические факты

Нарушение любого пункта ломает сборку или тесты.

- **`server/` — чистый ESM JavaScript (`.mjs`).** Не создавать `server/*.ts`.
- **Типы на сервере — JSDoc, проверка по одному файлу.** `pnpm typecheck:server`
  (`tsconfig.server.json`, `checkJs: false`) проверяет только файлы с
  `// @ts-check` в первой строке; ошибки импортируемых модулей не считаются.
  Каждый помеченный файл обязан стоять в `include` `tsconfig.server.json`
  (сторож — `test/server-typecheck-coverage.test.mjs`); список даёт
  `grep -rl '^// @ts-check' server/`. Типы — `@typedef`, `@param`, `@returns` и
  приведение `/** @type {T} */ (expr)`, рантайм не меняется. Если для зелёного
  нужна правка поведения — остановиться и вынести её отдельной задачей.
  Форма тактической клетки (`SceneCell`) объявлена в `server/dynamic-map.mjs`.
- **`src/` — TypeScript + React + Vite**, проверка `tsc --noEmit -p tsconfig.app.json`.
- **Тесты — встроенный `node:test`, файлы `test/*.test.mjs`.** Jest, Vitest и
  Playwright в проекте нет; браузерный сценарий проверяется вручную.
- Node `>=20.19.0`, пакетный менеджер **pnpm**.
- Хранилище — файлы в `storage/` (переопределяется `DND_STORAGE_DIR`). Базы нет.
- Версии в `package.json` — `^X.Y.Z`, совпадающие с `pnpm-lock.yaml`; менять
  только вместе с локом. **Новые зависимости — только по явному запросу
  пользователя**; предпочитать стандартную библиотеку Node.

## 2. Команды

```bash
pnpm dev              # клиент (vite :4173) + сервер (:8787)
pnpm dev:agent        # только сервер, server/index.mjs
pnpm dev:client       # только vite
pnpm start            # прод-запуск сервера

pnpm test                              # весь корпус, затем бюджет tactical-map отдельно
node --test test/rules-engine.test.mjs # один файл — так проверять точечные правки
pnpm build                             # tsc --noEmit + vite build
pnpm typecheck:server                  # tsc по файлам с // @ts-check
pnpm verify                            # test + typecheck:server + build; локально не запускать —
                                       # полный прогон делает CI (.github/workflows/verify.yml)

pnpm rules:verify     # rule-pack + rule-retriever
pnpm content:verify   # целостность контента и лицензий
pnpm spells:verify    # override заклинаний против каталога dnd.su;
                      # обязательно после правки data/dndsu-spell-mechanics-overrides.json
pnpm cutover:audit    # расхождения room/snapshot/replay (данные не меняет)
node tools/build-ascii-location-maps.mjs --all --check  # нарисованные карты мест
                      # (data/authored-maps/), без --check — запись в каталог
pnpm maps:preview     # карта текстом без кампании: --location, --theme, --seed;
                      # --preset all --audit — после правки генераторов карт
pnpm props:atlas      # атлас предметов: --sheets assets-src/prop-stamps, затем pnpm props:rights
pnpm terrain:tiles    # фактуры пола и стен из assets-src/floor-wall-stamps, затем pnpm terrain:rights
pnpm talespire:assets # таблица ассетов TaleSpire (--dir или TALESPIRE_DIR)
pnpm migrate:dry-run  # прогон миграций без записи
pnpm backup           # зашифрованная копия storage в ./backups; нужен DND_BACKUP_KEY
                      # (без него копия не расшифровывается). Справка —
                      # node tools/storage-backup.mjs --help
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
- **`storage/` — рабочие данные пользователя.** Тесты используют временный
  каталог; `storage/`, `data/` и сгенерированный контент не править без явной задачи.
- Не удалять и не переписывать чужие изменения в dirty worktree.

## 4. Карта кода

Прежде чем добавлять модуль, найти существующего владельца задачи. **Второго
авторитетного пути быть не должно:** создание кампании, загрузка, действия
игроков, ходы NPC и автономный Director идут через один Rules Engine.

**Каталоги:** `server/` — механика, оркестрация, persistence; `src/` — интерфейс;
`prompts/` — версионированные контракты агентов; `test/` — проверки; `docs/` —
архитектура, покрытие, ограничения; `tools/` — аудиты и обслуживание;
`server/migrations/` — миграции данных; `server/rules/` (`core`, `actors`,
`tactical-geometry`) — части движка, реэкспортируемые `rules-engine.mjs`;
`server/routes/` — HTTP-маршруты, вынесенные из `index.mjs`. Модули
`server/rules/*` не импортируют `rules-engine.mjs`: граф без циклов держит
`test/server-import-graph.test.mjs`.

**Ядро (единственные источники истины):**

| Файл | Ответственность |
| --- | --- |
| `server/rules-engine.mjs` | вся механика, допустимость, числа; точка входа для любого правила |
| `server/event-store.mjs` | события, commit, replay |
| `server/dice-service.mjs` | вся случайность; в тестах внедряется детерминированно |
| `server/roll-registry.mjs` | `roll_id`/`check_id`, срок действия, защита от повторного применения |
| `server/game-orchestrator.mjs` | оркестрация цикла `/api/narrate` |
| `server/index.mjs` | HTTP-сервер и маршруты |
| `server/store.mjs` | persistence поверх `storage/` |
| `server/security.mjs` | членство, владелец героя, полномочия |
| `server/viewer-projection.mjs` | что игрок имеет право видеть |

**Агентные роли.** `server/llm-client.mjs` импортирует **только**
`server/index.mjs`; остальные модули получают клиент внедрением
(`this.llmClient.completeJson(...)`). Прямой импорт `llm-client` ломает тесты
без ключа и детерминизм. Фактические привязки промптов (`readFileSync`):

| Файл | Промпт | Роль |
| --- | --- | --- |
| `server/director-agent.mjs` | `prompts/director/v4_story.txt`, `v4_chaos.txt` | темп, развилки, переходы; вариант по `improv_mode` в `choose()` |
| `server/npc-controller.mjs` | `prompts/npc_controller/v1.txt` | мораль и перелом боя NPC |
| `server/npc-social-controller.mjs` | `prompts/npc_controller/social_v7.txt` | социальные сцены; зацепки карты о собеседнике (`public_hooks_naming_npc`) |
| `server/narrator.mjs` | `prompts/narrator/v13.txt` | текст после commit; якоря карты (`landmarks`, `landmarks_absent`); сюжет сценария (`scenario`) |
| `server/scene-architect.mjs` | `prompts/map_architect/v8.txt` | новые области, заготовки (`secrets`), якоря (`map.design.landmarks`) |
| `server/campaign-bootstrap.mjs` | `prompts/campaign_creator/v8.txt` | исходная ситуация, заготовки (`secrets`), якоря первой карты |
| `server/action-adjudicator.mjs` | `prompts/action_adjudicator/v8.txt` | прочтение свободного действия и маршрут (`check`/`travel`/`talk`/`clarify`) |
| `server/campaign-recap.mjs` | `prompts/recap/v1.txt` | рекап «в прошлой серии» |

Других загрузок промптов нет. Остальные файлы в `prompts/` — прежние версии тех
же контрактов и few-shot, оставлены как история. Сторож соответствия —
`test/security.test.mjs`.

**Детерминированные модули без LLM** — не называть их «агентами»:
`adjudicator`, `intent-parser`, `world-memory`, `projection-integrity`,
`npc-turn-scheduler`, `campaign-loop-policy`, `world-deeds`, `captives`,
`parley`, `law-and-order`, `scene-requirements`, `scene-program-layout`,
`map-quality`, `weather`, `offscreen-world`, `loot-containers`, `tavern-life`,
`courier-letters`, `talespire-slab`, `talespire-import`, `map-library`,
`thin-walls`, `room-floors`, `detail-props`, `scene-features`, `scene-dressing`,
`reaction-preferences`, `campaign-scenario`, `scenario-attention`, `scenario-knight` (все — `server/*.mjs`).

**Маршрутизация ввода:** `server/player-request-router.mjs` объявляет
`PLAYER_REQUEST_ROLES`. `prompt_id` там — метаданные, а не привязка: его не
читает ни один модуль, он стоит только у ролей, исполняемых моделью (строка или
список вариантов). `worldkeeper` (детерминированный `answerKnownLore`) и
`game_master` (Rules Engine) — без `prompt_id`. Сторож —
`test/player-request-router.test.mjs`.

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
`ImportLocationMap`, маршрут — `server/routes/map-import-routes.mjs`.

**Домен NPC (не путать):**

- `npc-social.mjs` — профили, обещания, отношения; `npc-social-check.mjs` —
  навыковые проверки;
- `npc-turn-scheduler.mjs` — детерминированная боевая политика NPC;
- `npc-controller.mjs` (`NpcMoraleAgent`) — только мораль и перелом боя: вне
  момента морали `decide()` возвращает `null`;
- `captives.mjs` — пленные после сдачи и нелетального нокаута, СЛ допроса, пощада;
- `law-and-order.mjs` — розыск и стража. **Лист:** ничего из `server/` не
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

При изменении механики запускать соответствующий тест точечно
(`node --test test/<файл>.test.mjs`). Новые тесты писать на общем наборе
`test/kit/` (сервер с админом и игроками, кубики, движок с проверкой replay,
заглушка модели, сборка клиентского TS) — как, описано в `docs/testing.md`.
Свои копии `startServer`, `dice()` и `applyAll` не заводить. План дальнейших
волн — `docs/scalability-roadmap.md`.

| Инвариант | Сторож |
| --- | --- |
| Replay потока событий даёт то же состояние | `test/event-store.test.mjs`, `pnpm cutover:audit` |
| Потеря хвоста журнала или seed-снимка — явный отказ `CAMPAIGN_RECOVERY_REQUIRED`, а не тихая загрузка старого состояния; отказ одной кампании не роняет сервер | `test/event-store.test.mjs`, `test/recovery-required-api.test.mjs` |
| Повтор с тем же `idempotency_key` возвращает прежний commit; другая цель, тип команды, актор или endpoint под тем же ключом — `409 IDEMPOTENCY_CONFLICT` | `test/api-integration.test.mjs`, `test/game-flow-integration.test.mjs`, `test/command-retry-intent-api.test.mjs` |
| Все броски серверные, один бросок не применяется дважды; механическая проверка принимает только кость своей карточки | `test/dice-service.test.mjs`, `test/roll-registry.test.mjs`, `test/roll-binding.test.mjs` |
| Клиентские поля недоверенные (путь, дальность, цель) | `test/tactical-command-guard.test.mjs` |
| Права, членство и владелец героя проверяются сервером | `test/security.test.mjs` |
| Игрок видит только разрешённое, в том числе в уже открытом живом потоке после logout, истечения сессии и смены доступа; прогноз удара не выдаёт закрытую КД процентом попадания | `test/viewer-projection.test.mjs`, `test/viewer-projection-api.test.mjs`, `test/stream-live-access-api.test.mjs`, `test/combat-forecast-disclosure.test.mjs` |
| Рассказчик не создаёт событий и не объявляет смерть | `test/narrator.test.mjs` |
| Сгенерированная карта играбельна: дверь наружу, окна, комнаты, досягаемость, мебель не в проёмах и не за краем | `test/map-quality.test.mjs`, `pnpm maps:preview -- --preset all --audit` |
| Карта держит программу сцены: центр, посты и улики на месте и досягаемы; библиотечная карта без них не выбирается; двадцать мест корпуса строятся без замечаний | `test/scene-program-layout.test.mjs`, `test/map-library.test.mjs`, `test/scene-program-corpus.test.mjs` |
| В поселении у каждой двери дома есть дорога, на тропе ничего не стоит; отряд входит со стороны, откуда пришёл, а центр сцены стоит на площади | `test/settlement-generator.test.mjs` (`DOOR_OFF_ROAD`, `PATH_BLOCKED`), `test/scene-entry-road.test.mjs` |
| Рассказчик не описывает то, что сцена обещала, а карта не держит | `test/narrator.test.mjs` (`ABSENT_LANDMARK_MENTIONED`) |
| Перестройка карты — только ведущему, вне боя, голосования и открытой проверки; та же схема события, что у импорта, replay сходится | `test/map-import-command.test.mjs`, `test/map-import-api.test.mjs` |
| Враг встречи появляется по эту сторону дверей и окон от отряда | `test/encounter-assembler.test.mjs` |
| Параллельные команды не перезаписывают друг друга молча | `test/narrate-room-version-race.test.mjs`, `test/snapshot-projector-version.test.mjs` |
| Корпус тестов не ходит в интернет: каждый запуск `server/index.mjs` либо с пустым `ROUTERAI_API_KEY`, либо с локальным `ROUTERAI_BASE_URL` | `test/test-network-isolation.test.mjs` |
| Запрос не роняет сервер: тело — только JSON-объект, необработанная ошибка маршрута завершает свой запрос ответом 500 | `test/map-import-api.test.mjs`, `test/recovery-required-api.test.mjs` |
| Весь вызов модели и картинок идёт через учёт расхода; известный usage непригодного ответа тоже записывается | `test/usage-ledger.test.mjs`, `test/item-images-api.test.mjs` |
| Медленный читатель живого потока не копит кадры: комната и присутствие схлопываются до последнего состояния, очередь соединения ограничена, отзыв прав уходит напрямую | `test/narration-stream.test.mjs`, `test/stream-backpressure-api.test.mjs` |
| Карта читается только той, на которую указывает её хеш; библиотечная постройка выбирается, только если исправны все её этажи | `test/map-store.test.mjs`, `test/map-library.test.mjs` |
| Бэкап не снимается с работающего на том же storage сервера без явного `--allow-live` | `test/backup-service.test.mjs`, `test/storage-backup-cli.test.mjs` |
| Кампания по сценарию идёт по его узлам, финал — исход боя с главным противником в логове, развязка переживает replay | `test/campaign-scenario.test.mjs` |
| Внимание главного противника — вывод из журнала, игроку не видно; незнакомца ставит и раскрывает только сервер, выдох — серверными бросками; засаду и внезапность финала решает счёт, а не Режиссёр | `test/scenario-attention.test.mjs` |

Если новый инвариант нельзя привязать к тесту — он ещё не инвариант, а намерение.

## 6. Порядок реализации механики

1. Серверная **команда** → **правило** в Rules Engine → **событие** → **reducer**.
2. Только затем проекция, промпт и UI.
3. Prompt или React-компонент **не компенсируют** отсутствующее доменное правило.
4. Тесты на: успех, отказ, права, идемпотентность, replay. Случайность —
   через внедрённый детерминированный Dice Service.
5. Схемы событий и контракты промптов **версионировать**. Сохранённые кампании и
   старый replay не ломать без явной миграции в `server/migrations/`.

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
`server/usage-ledger.mjs`. Не добавлять вызов LLM в горячий путь хода.

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
удаления данных в `storage/`, изменения схемы событий без обратной совместимости,
новой зависимости, ослабления любого инварианта из раздела 5 или отступления от
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

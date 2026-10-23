# Как писать тесты

Тесты — встроенный `node:test`, файлы `test/*.test.mjs`. Общий набор помощников —
`test/kit/` (точка входа `test/kit/index.mjs`). Набор лежит в подкаталоге, поэтому
`tools/run-test-suite.mjs` его как тесты не запускает; самопроверка набора —
`test/test-kit.test.mjs`.

Запускать точечно: `node --test test/<файл>.test.mjs`. Полный корпус гоняет CI.

## Какой уровень выбрать

| Что проверяем | Уровень | Помощники |
| --- | --- | --- |
| правило, событие, reducer, replay | движок, без HTTP | `test/kit/engine.mjs`, `test/kit/dice.mjs` |
| права, видимость, маршрут, restart процесса | HTTP, настоящий `server/index.mjs` | `test/kit/http.mjs` |
| роль модели (рассказчик, режиссёр, …) | модуль с внедрённым клиентом | `scriptedLlm` из `test/kit/llm.mjs` |
| весь путь через `llm-client` и учёт расхода | HTTP + локальный провайдер | `startFakeProvider` + `startTestServer` |

Механику сначала закрывают на уровне движка: он быстрее на порядки и
детерминирован. HTTP-тест добавляют для того, что видно только через сервер:
членство и владелец героя, проекция для игрока, идемпотентность маршрута,
перезапуск процесса. По AGENTS.md §6 у новой механики проверены успех, отказ,
права, идемпотентность и replay.

## Уровень движка

```js
import { resolveCommand } from '../server/rules-engine.mjs'
import { dice } from './kit/dice.mjs'
import { applyAll, assertReplayMatches, commitEvents, createCampaignStore } from './kit/engine.mjs'

test('удар снимает хиты и переживает replay', async (t) => {
  const store = await createCampaignStore(t, 'HIT', initialState())   // временный каталог, удаляется сам
  const before = (await store.load('HIT')).state
  const result = resolveCommand(command, before, { diceService: dice([15, 4], { prefix: 'hit-roll' }) })
  await commitEvents(store, 'HIT', result.events)
  await assertReplayMatches(store, 'HIT', { expected: applyAll(before, result.events) })
})
```

- `dice(values, { prefix, now })` — броски строго по списку; лишний бросок или
  значение вне грани — `RangeError`, а не тихая подстановка. Ещё есть `maxDice`,
  `minDice`, `fixedDice(n)`, `diceThen(values, fallback)`.
- `createTestStore(t, options)` — журнал с reducer и нормализацией сервера;
  `normalize: false` — без `normalizeState`; прочие опции уходят в `FileEventStore`.
- `createEngine(values)` — `RulesEngine` с костями из набора.
- `assertReplayMatches` повторяет поток с нуля в новом экземпляре журнала (без
  снимков и кэша головы) и сравнивает с головой; `reopenStore` — тот же каталог
  «после перезапуска».

## HTTP-уровень

```js
import { addPlayer, createCampaign, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'

test('игрок не ходит чужим героем, ход переживает restart', async (t) => {
  const server = await startTestServer(t)                      // свободный порт, временное хранилище
  const { client: gm } = await setupAdmin(server)
  await createCampaign(gm, { code: 'MOVE', state: campaignState() })   // готовое состояние — только админ
  const { client: player } = await addPlayer(server, gm, 'MOVE', { heroIds: ['hero-2'] })
  assert.equal((await sendCommand(player, 'MOVE', 'foreign', moveCommand('hero-1'))).status, 403)
  await server.restart()                                       // то же хранилище, новый процесс
  assert.equal((await player.get('/api/rooms/MOVE')).status, 200)
})
```

- `startTestServer(t, { impl, env, dice, faults, setupToken, storagePrefix, storageDir, preload, args })`
  возвращает `{ impl, baseUrl, port, storageDir, setupToken, restart, stop, start,
  waitForExit, running, output, child }`. Остановка и удаление хранилища — в
  `t.after`. `stop()` + `start()` — окно, чтобы прочитать или испортить журнал
  (`readJournal`, `corruptCampaign`, `appendJournal`). `restart(overrides)` и
  `start(overrides)` принимают `{ dice, faults, env }` для следующих запусков
  (`null` снимает крючок); `waitForExit()` дожидается выхода процесса после
  сбоя `exit-*` и возвращает код, `running()` — жив ли процесс. Остановка
  штатная (SIGTERM): не завершился за 5 с — процесс добивается SIGKILL, а
  `stop()`/`restart()`/уборка в `t.after` отклоняются, то есть тест падает.
- Порт меняется на каждом запуске: клиенты кита читают `server.baseUrl` при
  каждом запросе, а сохранённый до `restart()` адрес устаревает. Сессии хранит
  storage — после перезапуска повторный вход не нужен. `server.child` после
  `restart()` — новый процесс, слушатель `exit` вешать заново.
- Клиент `createClient(server)` хранит свою cookie-сессию и переживает restart:
  `get/post/patch/put/delete` возвращают `{ status, body, text, headers, cookie }`,
  `fetch(path)` — сырой `Response` (файлы, SSE). Опция `idempotencyKey` ставит
  заголовок `X-Idempotency-Key`.
- `setupAdmin`, `registerUser`, `login`, `createCampaign`, `addPlayer`
  (приглашение → регистрация → вход по ссылке), `sendCommand`, `expectStatus`.
- Сервер нельзя собрать внутри процесса теста: модуль при импорте слушает порт
  и запускает фоновые часы. Поэтому это дочерний процесс; каждый запуск
  стоит ~0,5–1 с, и лишние HTTP-тесты заметно удлиняют корпус.

### Детерминированные кости и сбои на сервере — данными

Сервер бросает настоящими костями. Где исход важен, тест передаёт правила
костей **данными** — объектом или путём к `test/fixtures/<имя>.dice.json`:

```js
const server = await startTestServer(t, {
  dice: 'test/fixtures/mvp-player-cycle.dice.json',
  // или: dice: { rules: [{ actor: '^hero-1$', purpose: '^attack$', sides: 20, values: [18, 3], value: 'max' }] },
  faults: { commit: [{ idempotency_key: 'crash-key', mode: 'exit-before' }] },
  storagePrefix: 'skazanie-roll-reservation-',   // крючки работают только в skazanie-* во временном каталоге
})
```

Формат — контракт для обоих серверов, его описывает и проверяет
`test/kit/hooks-format.mjs`; набор кладёт JSON в `DND_TEST_DICE_RULES` и
`DND_COMMIT_FAULTS`. JS-сервер исполняет его предзагрузкой
`test/kit/server-hooks.mjs` (подключает набор сам), Rust-сервер будет читать те
же переменные (`src/test_hooks.rs`, задача С2 `rust/SERVER-PLAN.md`).

- Кости `skazanie.test-dice/1`: `rules` — по порядку, побеждает первое
  подходящее. Правило: `actor` и `purpose` — шаблоны (общее подмножество JS
  `RegExp` и Rust `regex`, без lookaround и обратных ссылок; `''` — бросок без
  актора), `sides` — только кости с этим числом граней, `values` — очередь
  значений, `value` — число (прижимается к грани), `"max"` или `"min"`.
  `unmatched: "error"` превращает кость без правила в отказ; по умолчанию она
  настоящая. Назначения бросков — `purpose` сервера (`initiative`, `attack`,
  `death_saving_throw`, `free_roll`, …).
- Сбои `skazanie.test-faults/1`: `commit` — по `idempotency_key`, режим `throw`
  (отказ до записи журнала), `exit-before` (выход 70 до записи), `exit-after`
  (журнал записан, выход 71 до ответа); `projection_ack` — отказ подтверждения
  проекции кампании `campaign` на версии `version`. Каждый сбой срабатывает
  один раз за жизнь процесса.
- Крючки принимаются только при `NODE_ENV=test` и хранилище `skazanie-*` прямо
  в системном временном каталоге, иначе сервер не стартует. Из окружения
  запуска они не наследуются; через `env` их передать нельзя — только `dice`
  и `faults`.

Прежние предзагрузки `test/fixtures/*-deterministic-dice.mjs` через `preload`
работают только против JS-сервера; новый тест их не заводит.

### Журнал глазами теста

Тест не открывает `<storage>/engine/...` сам: раскладка хранилища — деталь
сервера, у Rust-переноса журнал в SQLite. Помощники `test/kit/journal.mjs`:

```js
const journal = await readJournal(server, 'CODE')          // { state, state_version, current_state_version,
                                                            //   commits, events, pending_projection }
await readJournal(server, 'CODE', { atVersion: 3, useSnapshots: false })   // состояние на версии, повтором с нуля
await server.stop()
await corruptCampaign(server, 'CODE', 'tail')               // потерять последний коммит → EVENT_LOG_TAIL_MISSING
await corruptCampaign(server, 'CODE', 'seed')               // потерять seed-снимок v0 → SEED_SNAPSHOT_MISSING
await appendJournal(server, 'CODE', { idempotency_key: 'k', events: [/* … */] })   // коммит мимо сервера
await server.start()
```

`commits[]` — `{ idempotency_key, command_id, state_version_before,
state_version_after, events }`. `readJournal` повреждённой кампании отказывает
той же ошибкой `CAMPAIGN_RECOVERY_REQUIRED`, что и сервер. `corruptCampaign`
требует остановленного сервера. В режиме `rust` помощники зовут подкоманду
`skazanie-server journal` (контракт описан в шапке `test/kit/journal.mjs`).

### Контрактный режим: тот же тест против Rust-сервера

`SKAZANIE_SERVER_IMPL` выбирает реализацию сервера: `js` (по умолчанию,
эталон `server/index.mjs`) или `rust` — бинарь из `SKAZANIE_RUST_SERVER_BIN`
(абсолютный путь или от корня репозитория). Без бинаря набор отказывает
сообщением «Режим rust не готов», а не откатывается на JS. Бинарь запускает
только `spawnRust` набора с тем же `isolatedServerEnv`; сторож —
`test/test-network-isolation.test.mjs`.

Контрактный тест: сервер — только `startTestServer`, без своего `spawn`, без
`preload` и `args`; кости и сбои — `dice`/`faults`; журнал — помощники выше;
никакого чтения файлов `storage/`. Такие файлы вносятся в
`test/contract-rust.list`, когда их маршруты перенесены в `sk-server`:

```bash
(cd rust && cargo build --release -p sk-server --features test-hooks)   # крючки и подкоманда journal
SKAZANIE_RUST_SERVER_BIN=rust/target/release/skazanie-server pnpm test:contract:rust
pnpm test:contract:js      # тот же список против JS-эталона — обязан оставаться зелёным
```

Бинарь без фичи `test-hooks` с заданными `dice`/`faults` не стартует, а
`journal` у него нет: боевая сборка крючков не содержит.

### Перевод прежнего HTTP-теста на кит

Правило перевода: число проверок не меньше, каждая прежняя — на месте и с тем
же смыслом; файл зелёный до и после, затем зелёный
`test/test-network-isolation.test.mjs`. В `contract-rust.list` файл вносит
задача переноса маршрутов, когда Rust на нём зелёный.

| Было | Стало |
| --- | --- |
| свой `spawn` `server/index.mjs`, `freePort`, `mkdtemp`, ожидание health, `stopServer`, `rmSync` | `startTestServer(t, { … })` |
| `ADMIN_SETUP_TOKEN`; `ROUTERAI_API_KEY: ''`, `COOKIE_SECURE`, `AGENT_HOST`, `NODE_ENV`, `GAME_ENGINE_MODE` | `setupToken`; остальное ставит набор (последнюю сервер не читает) |
| прочие переменные сервера | `env: { … }` (кроме `DND_STORAGE_DIR` и `AGENT_PORT`) |
| свой HTTP-двойник провайдера | `startFakeProvider(t, handler)`, `env: provider.env` |
| `request(baseUrl, …)` + `sessionCookie(res)` | клиент на роль `createClient(server)`; чужая cookie — `request(path, { cookie })`, `cookie: null` — без неё. Ответ без `.response`, `body` — `null` для не-JSON |
| `logs`, `child.exitCode == null` | `server.output()`, `server.running()` |
| `--import …-deterministic-dice.mjs`, `fail-commit-once.mjs`, `fail-projection-ack-once.mjs` | `dice`, `faults: { commit, projection_ack }` (сбой снова взведён после `restart()`; снять — `start({ faults: null })`) |
| `FileEventStore` + `load`/`replay`, `getByIdempotencyKey`, обход `engine/campaigns/*/events` | `readJournal(server, code)` и его `commits` |
| `store.commit` мимо сервера, `rmSync` хвоста или seed | `appendJournal`; `stop()` → `corruptCampaign(server, code, 'tail' \| 'seed')` |

Хелпер `request` с трассой или особыми заголовками можно оставить, передавая
`server.baseUrl` при каждом вызове (образец — `mvp-player-cycle-api`).

Контрактом пока не становятся проверки, привязанные к файловому хранилищу JS:
`storage/rooms/*.json` и `metadata.json` кампании
(`projection-postcommit-error-api`, `reconcile-access-perf-api`), правка
`auth.json` (`stream-live-access-api`, `reconcile-access-perf-api`),
`storage/turn-traces/*` (`command-retry-intent-api`), `auditLegacyCutover`
(`soak-crash-recovery-api`, `restore-rehearsal-api`) и CLI хранилища
(`storage-backup-cli`). Запуск и HTTP в них идут через набор, а такие проверки
остаются как есть, пока не появится помощник набора с реализацией для обоих
серверов (по образцу `test/kit/journal.mjs`).

## Модель

Модуль получает клиент модели внедрением (`llmClient`), импортировать
`server/llm-client.mjs` в серверный модуль нельзя (AGENTS.md §4).

```js
const llm = scriptedLlm([{ narration: 'Дверь поддаётся.' }, new Error('timeout')])
const narrator = new Narrator({ llmClient: llm })
// …
assert.equal(llm.calls.length, 1)            // лишний вызов модели — ошибка теста
```

- `scriptedLlm(responses, { fallback })` — ответы по очереди: значение, `Error`
  (отказ) или функция `(input, options, n)`. Очередь кончилась без `fallback` —
  вызов падает с `LLM_UNEXPECTED_CALL`.
- `forbiddenLlm()` — для путей, где модели быть не должно (горячий путь хода).
- `startFakeProvider(t, handler)` — локальный провайдер в протоколе RouterAI
  (`/chat/completions`, `/images`); `chatCompletion(content)` строит ответ.
  Подключение: `startTestServer(t, { env: provider.env })`.

## Сторожа

| Сторож | Что держит |
| --- | --- |
| `test/test-network-isolation.test.mjs` | ни один запуск `server/index.mjs` не уходит в сеть: ключ пуст или есть локальный `ROUTERAI_BASE_URL`; набор — признанная точка запуска, его `isolatedServerEnv` проверяется исполнением; бинарь Rust запускается только набором и с тем же окружением |
| `test/test-kit.test.mjs` | помощники набора работают как описано |
| `test/server-import-graph.test.mjs` | `server/rules/*` не импортируют `rules-engine.mjs` |
| `test/server-typecheck-coverage.test.mjs` | файлы с `// @ts-check` стоят в `tsconfig.server.json` |
| `test/security.test.mjs` | привязки промптов и полномочия |
| `test/test-suite-runner.test.mjs` | порядок и изоляция запуска корпуса |

Инварианты продукта и их тесты — таблица в AGENTS.md §5.

## Правила

- Тест не ходит в интернет. Ключ провайдера в тесте — только вместе с
  локальным адресом; набор это проверяет сам и бросает исключение.
- Случайность — только через внедрённый `DiceService` (на сервере — правила
  `dice` данными).
- Хранилище — временный каталог; `storage/` и `data/` тесты не трогают.
- Лимит времени HTTP-теста — `runnerTimeout(ms)` из
  `test/shared-runner-timeout.mjs`: на общем раннере CI он втрое больше.

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

- `startTestServer(t, { env, preload, storagePrefix, storageDir })` возвращает
  `{ baseUrl, port, storageDir, restart, stop, start, output }`. Остановка и
  удаление хранилища — в `t.after`. `stop()` + `start()` — окно, чтобы прочитать
  журнал на диске напрямую.
- Клиент `createClient(server)` хранит свою cookie-сессию и переживает restart:
  `get/post/patch/put/delete` возвращают `{ status, body, text, headers, cookie }`,
  `fetch(path)` — сырой `Response` (файлы, SSE). Опция `idempotencyKey` ставит
  заголовок `X-Idempotency-Key`.
- `setupAdmin`, `registerUser`, `login`, `createCampaign`, `addPlayer`
  (приглашение → регистрация → вход по ссылке), `sendCommand`, `expectStatus`.
- Сервер нельзя собрать внутри процесса теста: модуль при импорте слушает порт
  и запускает фоновые часы. Поэтому это дочерний процесс; каждый запуск
  стоит ~0,5–1 с, и лишние HTTP-тесты заметно удлиняют корпус.

### Детерминированные кости на сервере

Сервер бросает настоящими костями. Где исход важен, тест подключает
предзагрузку, которая подменяет `DiceService.prototype` в дочернем процессе:

```js
const server = await startTestServer(t, {
  preload: 'test/fixtures/shillelagh-deterministic-dice.mjs',
  storagePrefix: 'skazanie-shillelagh-api-',   // предзагрузка проверяет имя хранилища
})
```

Образцы — `test/fixtures/*-deterministic-dice.mjs`. Предзагрузка обязана
отказываться работать вне `NODE_ENV=test` и вне своего временного хранилища.

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
| `test/test-network-isolation.test.mjs` | ни один запуск `server/index.mjs` не уходит в сеть: ключ пуст или есть локальный `ROUTERAI_BASE_URL`; набор — признанная точка запуска, его `isolatedServerEnv` проверяется исполнением |
| `test/test-kit.test.mjs` | помощники набора работают как описано |
| `test/server-import-graph.test.mjs` | `server/rules/*` не импортируют `rules-engine.mjs` |
| `test/server-typecheck-coverage.test.mjs` | файлы с `// @ts-check` стоят в `tsconfig.server.json` |
| `test/security.test.mjs` | привязки промптов и полномочия |
| `test/test-suite-runner.test.mjs` | порядок и изоляция запуска корпуса |

Инварианты продукта и их тесты — таблица в AGENTS.md §5.

## Правила

- Тест не ходит в интернет. Ключ провайдера в тесте — только вместе с
  локальным адресом; набор это проверяет сам и бросает исключение.
- Случайность — только через внедрённый `DiceService` (на сервере — предзагрузка).
- Хранилище — временный каталог; `storage/` и `data/` тесты не трогают.
- Лимит времени HTTP-теста — `runnerTimeout(ms)` из
  `test/shared-runner-timeout.mjs`: на общем раннере CI он втрое больше.

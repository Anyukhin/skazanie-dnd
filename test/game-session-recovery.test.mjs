import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import * as recovery from '../src/tactical-command-recovery.mjs'
import * as roomStream from '../src/room-stream.mjs'
import { canIssueUiTacticalCommand } from '../src/tactical-command-guard.mjs'
import { withLootTakenRecord } from '../src/loot-panel-rules.mjs'

/**
 * Аудит PR #131: REC-04, UI-08/REC-03, REC-02 и клиентская половина LIVE-01/02
 * на настоящих колбэках `useGameSession`.
 *
 * Хук транспилируется из `src/useGameSession.ts` тем же способом, что в пробе
 * аудита (docs/reviews/2026-10-04/round-4/23-queued-room-state-probe.mjs), и
 * исполняется с маленьким рендерером: `useState`/`useRef`/`useCallback`/
 * `useEffect` с настоящим сравнением зависимостей, эффекты перезапускаются
 * только при их смене — как в React. Чистые модули (`room-stream`,
 * `tactical-command-recovery`) и транспорт `src/ai-client.ts` с декодером хода
 * — настоящие; подменены только сеть (`fetch`), EventSource и хранилища.
 * DOM и планировщика React нет: перерисовка вызывается там, где её сделал бы
 * React, поэтому это проверка порядка колбэков, а не браузерный сценарий.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-game-session-'))
test.after(() => rmSync(buildDir, { recursive: true, force: true }))

function compile(args) {
  const result = spawnSync(process.execPath, [compiler, '--ignoreConfig', ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

// Транспорт — настоящий: тот же `narrateWithAgent` с декодером хода.
const clientDir = join(buildDir, 'client')
compile(['--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--lib', 'ES2022,DOM',
  '--strict', '--skipLibCheck', '--outDir', clientDir, join(root, 'src', 'ai-client.ts')])
renameSync(join(clientDir, 'ai-client.js'), join(clientDir, 'ai-client.mjs'))
const client = await import(pathToFileURL(join(clientDir, 'ai-client.mjs')).href)

// Хук — без импортов: их подставляет контекст ниже.
const sessionSource = readFileSync(join(root, 'src', 'useGameSession.ts'), 'utf8')
const hookPath = join(buildDir, 'hook.ts')
writeFileSync(hookPath, sessionSource.slice(sessionSource.indexOf('const ACTIVE_CAMPAIGN_KEY ='))
  .replace('export function useGameSession', 'function useGameSession'))
compile(['--noCheck', '--target', 'ES2022', '--module', 'ES2022', '--outDir', buildDir, hookPath])
const hookCode = readFileSync(join(buildDir, 'hook.js'), 'utf8').replace(/export \{\};\s*$/u, '')

const ACTIVE_CAMPAIGN_KEY = 'skazanie-active-campaign-v2'
const settle = async (rounds = 8) => { for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve)) }
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function memoryStorage() {
  const values = new Map()
  return {
    values,
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  }
}

class FakeEventSource {
  static instances = []

  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.closed = false
    FakeEventSource.instances.push(this)
  }

  addEventListener(name, listener) { this.listeners.set(name, listener) }
  removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name) }
  close() { this.closed = true }
  emit(name, value) { if (!this.closed) this.listeners.get(name)?.({ data: typeof value === 'string' ? value : JSON.stringify(value) }) }
  open() { this.onopen?.() }
}

class FakeBroadcastChannel {
  postMessage() {}
  close() {}
}

function roomState(campaign, extra = {}) {
  return {
    sessionCode: campaign,
    campaign: `Кампания ${campaign}`,
    partyName: 'Отряд',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Герой', hp: 10, maxHp: 10, inventory: [], abilities: {}, currency: {} }],
    activePlayerId: 'hero',
    messages: [],
    pendingCheck: null,
    pendingAction: null,
    agentInteraction: null,
    isNarrating: false,
    state_version: 1,
    scene: null,
    enemies: [],
    merchants: [],
    ...extra,
  }
}

const sameDeps = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))

/**
 * Монтирует хук в изолированном «браузере». `routes` — пары [регулярное
 * выражение по URL, обработчик]; всё прочее получает 404, как незнакомый путь.
 */
function mountSession({ campaign = 'A', accountId = 'account-a', onAccessRevoked, routes = [] } = {}) {
  const localStorage = memoryStorage()
  const sessionStorage = memoryStorage()
  const timers = []
  const window = {
    location: { search: `?room=${campaign}`, href: `http://localhost/?room=${campaign}` },
    history: {
      replaceState: (_state, _title, url) => {
        window.location.href = String(url)
        window.location.search = new URL(String(url)).search
      },
    },
    localStorage,
    sessionStorage,
    BroadcastChannel: FakeBroadcastChannel,
    EventSource: FakeEventSource,
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  }
  // defineProperty, а не присваивание: в новых Node `localStorage` на
  // globalThis — встроенный аксессор, и простое присваивание ему не годится.
  for (const [name, value] of Object.entries({ window, localStorage, sessionStorage, BroadcastChannel: FakeBroadcastChannel, EventSource: FakeEventSource })) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  FakeEventSource.instances.length = 0

  const requests = []
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    const body = init.body ? JSON.parse(String(init.body)) : null
    requests.push({ url, method: init.method ?? 'GET', body })
    for (const [pattern, handler] of routes) if (pattern.test(url)) return handler({ url, body })
    return json(404, { error: 'Не найдено' })
  }

  const slots = []
  let cursor = 0
  let effects = []
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[index]
      return [slot.value, (value) => { slot.value = typeof value === 'function' ? value(slot.value) : value }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useCallback(callback, deps) {
      const index = cursor++
      if (slots[index] && sameDeps(slots[index].deps, deps)) return slots[index].callback
      slots[index] = { callback, deps }
      return callback
    },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = slots[index]
      if (previous && sameDeps(previous.deps, deps)) return
      effects.push({ index, effect, cleanup: previous?.cleanup })
      slots[index] = { deps, cleanup: previous?.cleanup }
    },
  }
  const context = {
    ...react,
    emptyState: roomState(campaign, { campaign: 'Кампания не выбрана' }),
    ApiRequestError: client.ApiRequestError,
    autoRollEnabled: client.autoRollEnabled,
    fetchWithTimeout: client.fetchWithTimeout,
    generateItemImage: async () => ({ url: '', model: 'test' }),
    isStateVersionConflictError: client.isStateVersionConflictError,
    narrateWithAgent: client.narrateWithAgent,
    newIdempotencyKey: client.newIdempotencyKey,
    publishNarrationPreview: client.publishNarrationPreview,
    rollDice: client.rollDice,
    rollSharedDie: client.rollSharedDie,
    playerMessage: (author, text) => ({ id: `player-${Math.random()}`, speaker: 'player', author, text, timestamp: '' }),
    withLootTakenRecord,
    forgetSceneMaps: () => {},
    latestSceneMapHash: () => '',
    resolveSceneMap: (scene) => scene,
    canIssueUiTacticalCommand,
    ...recovery,
    ...roomStream,
  }
  const useGameSession = new Function(...Object.keys(context), `${hookCode}\nreturn useGameSession`)(...Object.values(context))
  const props = { accountId, ...(onAccessRevoked ? { onAccessRevoked } : {}) }
  // Перерисовка: React сделал бы её сам после setState. Сначала очистки
  // сменившихся эффектов, потом сами эффекты — тем же порядком, что в React.
  // Эффект мог сам поменять состояние (например, применить отложенный
  // снимок), поэтому рисуем ещё раз, пока эффекты не перестанут срабатывать.
  const render = () => {
    for (let pass = 0; pass < 10; pass += 1) {
      cursor = 0
      effects = []
      const session = useGameSession(props)
      if (!effects.length) return session
      for (const item of effects) item.cleanup?.()
      for (const item of effects) {
        const cleanup = item.effect()
        slots[item.index].cleanup = typeof cleanup === 'function' ? cleanup : undefined
      }
    }
    throw new Error('Эффекты не успокоились за десять перерисовок')
  }
  const unmount = () => { for (const slot of slots) slot?.cleanup?.() }
  return { render, unmount, requests, timers, localStorage, sessionStorage, window }
}

const streamFor = (campaign) => FakeEventSource.instances.filter((source) => source.url.includes(`/campaigns/${campaign}/stream`)).at(-1)

test('REC-04: после смены кампании отложенный снимок прежней не возвращает её на экран, а снимок новой применяется', async () => {
  const narrate = []
  const harness = mountSession({
    routes: [
      [/\/api\/narrate$/u, () => narrate.shift()()],
      [/\/api\/rooms\/B$/u, () => json(200, { version: 1, state: roomState('B') })],
    ],
  })
  let session = harness.render()
  const streamA = streamFor('A')
  streamA.emit('room', { version: 5, state: roomState('A', { state_version: 5 }) })
  session = harness.render()
  assert.equal(session.state.campaign, 'Кампания A')

  // Свободное действие в A ждёт ответа; снимок A версии 7 уходит в очередь.
  const heldA = deferred()
  narrate.push(() => heldA.promise)
  const pendingA = session.submitAction('Проверяю силу', 'hero')
  await settle()
  session = harness.render()
  assert.equal(session.state.isNarrating, true)
  streamA.emit('room', { version: 7, state: roomState('A', { campaign: 'Кампания A, версия 7', state_version: 7 }) })

  // Игрок выбирает B. Хвост потока A долетает раньше, чем React снимет подписку.
  await session.switchCampaign('B')
  streamA.emit('room', { version: 8, state: roomState('A', { campaign: 'Кампания A, версия 8', state_version: 8 }) })
  session = harness.render()
  assert.equal(session.state.sessionCode, 'B')
  assert.equal(session.state.campaign, 'Кампания B', 'очередь A не перекрыла загруженную B')
  assert.equal(harness.localStorage.getItem(ACTIVE_CAMPAIGN_KEY), 'B', 'кэш активной кампании совпадает с экраном')
  assert.equal(new URL(harness.window.location.href).searchParams.get('room'), 'B')
  assert.equal(streamA.closed, true, 'подписка A снята')

  // Поздний ответ действия A отменяется и экрана не трогает.
  heldA.resolve(json(200, { narration: 'Поздний ответ A', effects: {} }))
  assert.deepEqual(await pendingA, { ok: false, error: 'Действие было отменено.' })
  session = harness.render()
  assert.equal(session.state.campaign, 'Кампания B')

  // Снимок самой B, отложенный на время её действия, применяется: хвост A не
  // сдвинул счётчик версий B своим номером 8.
  const heldB = deferred()
  narrate.push(() => heldB.promise)
  const pendingB = session.submitAction('Осматриваюсь', 'hero')
  await settle()
  session = harness.render()
  streamFor('B').emit('room', { version: 2, state: roomState('B', { campaign: 'Кампания B, версия 2', state_version: 2 }) })
  session = harness.render()
  assert.equal(session.state.campaign, 'Кампания B', 'пока ждём ответа, снимок B отложен')
  heldB.resolve(json(200, { narration: 'Тихо.', effects: {}, room_version: 1 }))
  assert.deepEqual(await pendingB, { ok: true })
  session = harness.render()
  assert.equal(session.state.campaign, 'Кампания B, версия 2')
  harness.unmount()
})

test('UI-08/REC-03: неполный ответ 200 не блокирует хук, а повтор той же заявки идёт с прежним ключом', async () => {
  const bodies = []
  const replies = [
    () => json(200, {}),
    () => json(200, { narration: 'Сила не подвела.', effects: {}, idempotent_replay: true }),
  ]
  const harness = mountSession({ routes: [[/\/api\/narrate$/u, ({ body }) => { bodies.push(body); return replies.shift()() }]] })
  let session = harness.render()
  streamFor('A').emit('room', { version: 3, state: roomState('A') })
  session = harness.render()

  const first = await session.submitAction('Проверяю силу', 'hero')
  assert.equal(first.ok, false)
  assert.equal(first.uncertain, true, 'неполный ответ — неизвестный исход')
  session = harness.render()
  assert.equal(session.state.isNarrating, false, 'ход не остался «в работе»')

  const second = await session.submitAction('Проверяю силу', 'hero')
  assert.deepEqual(second, { ok: true }, 'тот же экземпляр хука принимает следующее действие')
  assert.equal(bodies[1].idempotency_key, bodies[0].idempotency_key, 'повтор — с прежним ключом (REC-01)')
  session = harness.render()
  assert.equal(session.state.messages.at(-1).text, 'Сила не подвела.')
  harness.unmount()
})

test('UI-08/REC-03: исключение при показе принятого ответа снимает блокировку хода', async () => {
  const replies = [
    // Декодер проверяет только то, что клиент читает без условий; битый герой
    // внутри состояния роняет слияние уже после ответа.
    () => json(200, { narration: 'Ок.', effects: {}, authoritative_state: { players: [null] } }),
    () => json(200, { narration: 'Дверь открыта.', effects: {} }),
  ]
  const harness = mountSession({ routes: [[/\/api\/narrate$/u, () => replies.shift()()]] })
  let session = harness.render()
  streamFor('A').emit('room', { version: 3, state: roomState('A') })
  session = harness.render()

  const first = await session.submitAction('Осматриваюсь', 'hero')
  assert.equal(first.ok, false)
  session = harness.render()
  assert.equal(session.state.isNarrating, false)
  assert.match(session.state.messages.at(-1).text, /не удалось завершить на экране/u)

  const second = await session.submitAction('Открываю дверь', 'hero')
  assert.deepEqual(second, { ok: true })
  harness.unmount()
})

test('REC-02: повтор голоса и общего броска после неизвестного исхода идёт с прежним ключом', async () => {
  const vote = { id: 'decision-1', type: 'vote', status: 'open', options: [{ id: 'north', label: 'Север' }, { id: 'south', label: 'Юг' }] }
  const roll = { id: 'decision-2', type: 'roll', status: 'open', options: [{ id: 'fate', label: 'Судьба' }] }
  const voteBodies = []
  const rollBodies = []
  const voteReplies = [
    () => { throw new TypeError('fetch failed') },
    () => json(200, { version: 6, state: roomState('A', { agentInteraction: vote }) }),
    () => json(200, { version: 7, state: roomState('A', { agentInteraction: vote }) }),
  ]
  const rollReplies = [
    () => json(503, { error: 'Прокси не дождался ответа' }),
    () => json(200, { version: 8, state: roomState('A', { agentInteraction: roll }), roll: { id: 'roll-1', total: 14 } }),
    () => json(409, { error: 'Решение уже принято', code: 'PARTY_DECISION_CLOSED' }),
  ]
  const harness = mountSession({
    routes: [
      [/\/party-decisions\/decision-1\/votes$/u, ({ body }) => { voteBodies.push(body); return voteReplies.shift()() }],
      [/\/party-decisions\/decision-2\/roll$/u, ({ body }) => { rollBodies.push(body); return rollReplies.shift()() }],
    ],
  })
  let session = harness.render()
  streamFor('A').emit('room', { version: 5, state: roomState('A', { agentInteraction: vote }) })
  session = harness.render()
  const partyKey = recovery.pendingPartyDecisionStorageKey('account-a', 'A')

  await session.voteAgentInteraction('hero', 'north')
  session = harness.render()
  assert.match(session.directorError, /Повторите то же действие/u)
  assert.ok(harness.sessionStorage.getItem(partyKey), 'запись голоса пережила обрыв')

  await session.voteAgentInteraction('hero', 'north')
  session = harness.render()
  assert.equal(voteBodies[1].idempotency_key, voteBodies[0].idempotency_key, 'тот же голос — тот же ключ')
  assert.deepEqual(voteBodies[1], voteBodies[0])
  assert.equal(session.directorError, null)
  assert.equal(harness.sessionStorage.getItem(partyKey), null, 'принятый ответ снимает запись')

  await session.voteAgentInteraction('hero', 'south')
  assert.notEqual(voteBodies[2].idempotency_key, voteBodies[0].idempotency_key, 'другой вариант — новый ключ')
  assert.equal(voteBodies[2].option_id, 'south')

  streamFor('A').emit('room', { version: 9, state: roomState('A', { agentInteraction: roll }) })
  session = harness.render()
  await assert.rejects(session.rollAgentInteraction('hero'), (error) => error.status === 503)
  assert.ok(harness.sessionStorage.getItem(partyKey), 'запись броска пережила 503')
  const rolled = await session.rollAgentInteraction('hero')
  assert.equal(rolled.total, 14, 'повтор вернул уже выпавшую кость')
  assert.equal(rollBodies[1].idempotency_key, rollBodies[0].idempotency_key)

  await assert.rejects(session.rollAgentInteraction('hero'), (error) => error.status === 409)
  assert.notEqual(rollBodies[2].idempotency_key, rollBodies[0].idempotency_key, 'после известного исхода — новый ключ')
  assert.equal(harness.sessionStorage.getItem(partyKey), null, 'авторитетный отказ снимает запись')
  harness.unmount()
})

test('LIVE-01/02: кадр отзыва закрывает поток, аккаунт сверяется один раз, без переподключения вслепую', async () => {
  const reasons = []
  const harness = mountSession({
    onAccessRevoked: async (reason) => { reasons.push(reason); return null },
    routes: [[/\/api\/rooms\/A$/u, () => json(401, { error: 'Нужно войти' })]],
  })
  let session = harness.render()
  const stream = streamFor('A')
  stream.open()
  session = harness.render()
  assert.equal(session.connectionState, 'connected')

  stream.emit('access', { status: 'revoked', reason: 'session_ended' })
  assert.equal(stream.closed, true, 'поток закрыт сразу, браузер не переподключится сам')
  await settle()
  session = harness.render()
  assert.deepEqual(reasons, ['session_ended'], 'аккаунт сверяется ровно один раз')
  assert.equal(session.connectionState, 'revoked')
  assert.equal(FakeEventSource.instances.length, 1, 'нового подключения нет')
  assert.equal(harness.timers.length, 0, 'переподключение не запланировано')
  stream.onerror?.()
  assert.equal(harness.timers.length, 0, 'поздняя ошибка закрытого потока не будит переподключение')
  harness.unmount()
})

test('LIVE-01/02: если доступ к комнате подтвердился, поток переподключается один раз', async () => {
  const harness = mountSession({
    onAccessRevoked: async () => null,
    routes: [[/\/api\/rooms\/A$/u, () => json(200, { version: 3, state: roomState('A') })]],
  })
  let session = harness.render()
  const stream = streamFor('A')
  stream.open()
  stream.emit('access', { status: 'revoked', reason: 'access_unverified' })
  await settle()
  session = harness.render()
  assert.equal(FakeEventSource.instances.length, 2, 'переподключение после проверки, а не вслепую')
  assert.notEqual(session.connectionState, 'revoked')
  streamFor('A').open()
  session = harness.render()
  assert.equal(session.connectionState, 'connected')
  harness.unmount()
})

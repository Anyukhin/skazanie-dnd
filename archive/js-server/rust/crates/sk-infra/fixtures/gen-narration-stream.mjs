// Эталон `server/narration-stream.mjs` для `tests/narration_stream_fixture.rs`.
//
// Случайные сценарии (seeded mulberry32) двух видов:
// - поток рассказа кампании с ручными таймерами и ручными часами: подключения,
//   start/progress/complete/abort/replay, срабатывание таймеров, вытеснение;
// - очередь кадров соединения: send с ключами и без, занятый сокет, drain,
//   discard, ошибки сборки кадра, переполнение.
// Для каждой операции записаны результат, отказ и кадры, ушедшие за неё.
//
// Запуск из корня репозитория:
//   node rust/crates/sk-infra/fixtures/gen-narration-stream.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CampaignNarrationStream, CampaignStreamOutbox, campaignStreamFrameKey } from '../../../../server/narration-stream.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const UNDEFINED = { undefined: true }
const pick = (random, list) => list[Math.floor(random() * list.length)]
const errorOf = (error) => ({ code: error?.code ?? error?.name, message: error?.message })

const CAMPAIGNS = ['alpha', 'alpha', 'alpha', 'alpha', 'ALPHA', ' alpha ', 'beta', 'beta', '', '  ']
const MESSAGES = ['m-1', 'm-1', 'm-1', 'm-2', 'm-2', 'm-3', 'm-4', ' m-2 ', 'bad id', '', 'x'.repeat(121), 'narration:ok.1']
const PROGRESS_TEXTS = [UNDEFINED, '', 'Первое.', 'Первое. Второе.', 'я'.repeat(6144), 'я'.repeat(6145), 'Текст с "кавычкой"']
const FINAL_TEXTS = [UNDEFINED, '', 'Канонический текст.', 'я'.repeat(6145), '"'.repeat(9000)]
const PHASES = [UNDEFINED, 'complete', 'replaced', 'aborted', 'start', 'bogus']
const REPLAYED = [UNDEFINED, true, false, 1, 0]

function hubScenario(seed) {
  const random = mulberry32(seed)
  const config = { max_active: pick(random, [1, 2, 3, UNDEFINED]), coalesce_ms: pick(random, [50, 0]) }
  const campaigns = new Map()
  const connections = new Map()
  const timers = []
  let clock = 1_000
  let emitted = []
  const hub = new CampaignNarrationStream({
    connectionsFor: (campaignId) => campaigns.get(String(campaignId).toUpperCase()) ?? [],
    write: (connection, event, payload) => { emitted.push({ connection: connection.id, event, payload }) },
    ...(config.max_active === UNDEFINED ? {} : { maxActive: config.max_active }),
    coalesceMs: config.coalesce_ms,
    setTimer: (callback) => {
      const timer = { callback, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
    },
    now: () => clock,
  })
  const steps = []
  let nextConnection = 1
  const count = 50 + Math.floor(random() * 50)
  for (let index = 0; index < count; index += 1) {
    const op = pick(random, ['connect', 'start', 'start', 'progress', 'progress', 'progress', 'tick', 'flush', 'fire_one', 'complete', 'abort', 'replay', 'active_count', 'close'])
    const step = { op }
    emitted = []
    try {
      if (op === 'connect') {
        step.campaign = pick(random, CAMPAIGNS)
        step.id = `c${nextConnection++}`
        const connection = { id: step.id, closed: false, res: { destroyed: false } }
        connections.set(step.id, connection)
        const key = String(step.campaign).toUpperCase()
        campaigns.set(key, [...(campaigns.get(key) ?? []), connection])
      } else if (op === 'close') {
        step.id = connections.size ? pick(random, [...connections.keys()]) : 'none'
        const connection = connections.get(step.id)
        if (connection) {
          if (random() < 0.5) connection.closed = true
          else connection.res.destroyed = true
        }
      } else if (op === 'start') {
        step.campaign = pick(random, CAMPAIGNS)
        step.message_id = pick(random, MESSAGES)
        step.result = hub.start(step.campaign, { messageId: step.message_id })
      } else if (op === 'progress') {
        step.campaign = pick(random, CAMPAIGNS)
        step.message_id = pick(random, MESSAGES)
        const text = pick(random, PROGRESS_TEXTS)
        if (text !== UNDEFINED) step.text = text
        hub.progress(step.campaign, { messageId: step.message_id, text: step.text })
      } else if (op === 'tick') {
        step.ms = pick(random, [0, 1, 10, 100])
        clock += step.ms
      } else if (op === 'flush') {
        while (timers.length) timers.shift().callback()
      } else if (op === 'fire_one') {
        if (timers.length) timers.shift().callback()
      } else if (op === 'complete') {
        step.campaign = pick(random, CAMPAIGNS)
        step.message_id = pick(random, MESSAGES)
        const text = pick(random, FINAL_TEXTS)
        const phase = pick(random, PHASES)
        const replayed = pick(random, REPLAYED)
        if (text !== UNDEFINED) step.text = text
        if (phase !== UNDEFINED) step.phase = phase
        if (replayed !== UNDEFINED) step.replayed = replayed
        step.result = hub.complete(step.campaign, { messageId: step.message_id, text: step.text, phase: step.phase, replayed: step.replayed })
      } else if (op === 'abort') {
        step.campaign = pick(random, CAMPAIGNS)
        step.message_id = pick(random, MESSAGES)
        step.result = hub.abort(step.campaign, { messageId: step.message_id })
      } else if (op === 'replay') {
        step.campaign = pick(random, CAMPAIGNS)
        step.id = connections.size ? pick(random, [...connections.keys()]) : 'none'
        hub.replay(step.campaign, connections.get(step.id) ?? { id: step.id, closed: false, res: { destroyed: false } })
      } else if (op === 'active_count') {
        step.campaign = pick(random, CAMPAIGNS)
        step.result = hub.activeCount(step.campaign)
      }
    } catch (error) {
      step.error = errorOf(error)
      delete step.result
    }
    step.events = emitted
    step.timers = timers.length
    steps.push(step)
  }
  const configOut = { coalesce_ms: config.coalesce_ms }
  if (config.max_active !== UNDEFINED) configOut.max_active = config.max_active
  return { seed, config: configOut, steps }
}

const EVENTS = ['room', 'presence', 'heartbeat', 'narration.chunk', 'narration.complete', 'access', 'custom']
function payloadFor(random, event) {
  if (event === 'room') return { version: Math.floor(random() * 100) }
  if (event === 'presence') return { typing_actor_ids: [pick(random, ['hero', 'ally', 'mage'])] }
  if (event === 'heartbeat') return {}
  if (event.startsWith('narration.')) return pick(random, [{ message_id: pick(random, ['n-1', 'n-2', 'n-3', 'n-4', 'n-5']), text: 'Текст' }, { message_id: '', text: 'без id' }, { text: 'нет id' }])
  return { status: pick(random, ['revoked', 'ok']) }
}

function outboxScenario(seed) {
  const random = mulberry32(seed)
  const config = { max_pending: pick(random, [1, 2, 3, UNDEFINED, 0, 2.5]), ready: pick(random, [true, false]) }
  const chunks = []
  const state = { ready: config.ready, closed: false, closeReasons: [] }
  const outbox = new CampaignStreamOutbox({
    write: (chunk) => {
      if (state.closed) return null
      chunks.push(chunk)
      return state.ready
    },
    ...(config.max_pending === UNDEFINED ? {} : { maxPending: config.max_pending }),
    onClose: (reason) => {
      state.closed = true
      state.closeReasons.push(reason)
    },
  })
  const steps = []
  const count = 40 + Math.floor(random() * 40)
  for (let index = 0; index < count; index += 1) {
    const op = pick(random, ['send', 'send', 'send', 'send', 'ready', 'drain', 'drain', 'discard'])
    const step = { op }
    const before = chunks.length
    const closesBefore = state.closeReasons.length
    try {
      if (op === 'send') {
        step.event = pick(random, EVENTS)
        step.payload = payloadFor(random, step.event)
        step.render = pick(random, ['ok', 'ok', 'ok', 'null', 'throw'])
        const keyMode = pick(random, ['auto', 'auto', 'null', 'custom'])
        step.key = keyMode === 'auto' ? campaignStreamFrameKey(step.event, step.payload) : keyMode === 'null' ? null : pick(random, ['room', 'k-1'])
        const event = step.event
        const payload = step.payload
        const render = step.render
        step.result = outbox.send(step.key, () => {
          if (render === 'throw') throw new Error('проекция не собралась')
          if (render === 'null') return null
          return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
        })
      } else if (op === 'ready') {
        step.value = pick(random, [true, false, null])
        state.ready = step.value
      } else if (op === 'drain') {
        outbox.drain()
      } else if (op === 'discard') {
        outbox.discard()
      }
    } catch (error) {
      step.error = errorOf(error)
      delete step.result
    }
    step.chunks = chunks.slice(before)
    step.closes = state.closeReasons.slice(closesBefore)
    step.pending = outbox.pendingCount
    steps.push(step)
  }
  const configOut = { ready: config.ready }
  if (config.max_pending !== UNDEFINED) configOut.max_pending = config.max_pending
  return { seed, config: configOut, steps }
}

function frameKeys() {
  const random = mulberry32(99)
  const cases = []
  const events = ['room', 'presence', 'heartbeat', 'narration.chunk', 'narration.start', 'narration.', 'narration', 'access', '', 'ROOM']
  const payloads = [{}, null, [], 'text', { message_id: 'a' }, { message_id: '' }, { message_id: 0 }, { message_id: 7 }, { message_id: true }, { message_id: ['x', 'y'] }, { message_id: { id: 1 } }]
  for (let index = 0; index < 150; index += 1) {
    const event = pick(random, events)
    const payload = pick(random, payloads)
    cases.push({ event, payload, key: campaignStreamFrameKey(event, payload) })
  }
  return cases
}

const hub = []
for (let seed = 1; seed <= 40; seed += 1) hub.push(hubScenario(seed))
const outbox = []
for (let seed = 1; seed <= 40; seed += 1) outbox.push(outboxScenario(seed))
const fixture = { hub, outbox, frame_keys: frameKeys() }
// Длинные однородные строки (пределы в 12 и 16 КБ) пишутся свёрнутыми:
// `"\u0000repeat:<символ>:<число>"`; тест разворачивает их обратно.
const fold = (key, value) => {
  if (typeof value !== 'string' || value.length < 200) return value
  const [first] = value
  return value === first.repeat(value.length / first.length) ? `\u0000repeat:${first}:${value.length / first.length}` : value
}
writeFileSync(join(here, 'narration-stream.json'), `${JSON.stringify(fixture, fold)}\n`, 'utf8')
const total = (list) => list.reduce((sum, entry) => sum + entry.steps.length, 0)
console.log(`narration-stream: поток ${hub.length} сценариев / ${total(hub)} операций, очередь ${outbox.length} / ${total(outbox)}, ключей ${fixture.frame_keys.length}`)

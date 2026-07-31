import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CampaignNarrationStream,
  NARRATION_STREAM_EVENT_MAX_BYTES,
  NARRATION_STREAM_MAX_ACTIVE_PER_CAMPAIGN,
  NARRATION_STREAM_TEXT_MAX_BYTES,
} from '../server/narration-stream.mjs'

function harness({ write = null, maxActive, coalesceMs = 50 } = {}) {
  const campaigns = new Map()
  const events = []
  const timers = []
  const connectionsFor = (campaignId) => campaigns.get(String(campaignId).toUpperCase()) ?? []
  const hub = new CampaignNarrationStream({
    connectionsFor,
    write: write ?? ((connection, event, payload) => {
      events.push({ connection: connection.id, event, payload })
      return true
    }),
    maxActive,
    coalesceMs,
    setTimer: (callback) => {
      const timer = { callback, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
    },
  })
  const connect = (campaignId, id) => {
    const normalized = String(campaignId).toUpperCase()
    const connection = { id, closed: false, res: { destroyed: false } }
    campaigns.set(normalized, [...(campaigns.get(normalized) ?? []), connection])
    return connection
  }
  const flush = () => {
    while (timers.length) timers.shift().callback()
  }
  return { hub, events, connect, flush, timers }
}

test('поток объединяет дельты в полный публичный снимок без авторитетного состояния', () => {
  const { hub, events, connect, flush } = harness()
  connect('alpha', 'viewer')

  hub.start('alpha', {
    messageId: 'narration-safe',
    roomVersion: 999,
    authoritative_state: { secret: true },
  })
  hub.progress('alpha', { messageId: 'narration-safe', text: 'Первое.' })
  hub.progress('alpha', {
    messageId: 'narration-safe',
    text: 'Первое. Второе.',
    mechanics: [{ hidden: true }],
  })
  flush()
  hub.complete('alpha', {
    messageId: 'narration-safe',
    text: 'Первое. Второе.',
    phase: 'complete',
  })

  assert.deepEqual(events.map(({ event }) => event), [
    'narration.start',
    'narration.chunk',
    'narration.complete',
  ])
  assert.equal(events[1].payload.text, 'Первое. Второе.')
  assert.deepEqual(Object.keys(events[1].payload).sort(), [
    'message_id', 'phase', 'replace', 'replayed', 'text',
  ])
  assert.equal(JSON.stringify(events).includes('secret'), false)
  assert.equal(JSON.stringify(events).includes('mechanics'), false)
  assert.ok(Buffer.byteLength(JSON.stringify(events[1].payload), 'utf8') <= NARRATION_STREAM_EVENT_MAX_BYTES)
})

test('переподключение получает последний полный снимок только своей кампании', () => {
  const { hub, events, connect } = harness()
  connect('alpha', 'first')
  connect('beta', 'other-campaign')
  hub.start('alpha', { messageId: 'narration-reconnect' })
  hub.progress('alpha', { messageId: 'narration-reconnect', text: 'Уже проверено.' })

  const reconnect = connect('alpha', 'reconnect')
  hub.replay('alpha', reconnect)

  const replay = events.find((entry) => entry.connection === 'reconnect')
  assert.equal(replay.event, 'narration.chunk')
  assert.equal(replay.payload.text, 'Уже проверено.')
  assert.equal(events.some((entry) => entry.connection === 'other-campaign'), false)
})

test('backpressure сохраняет только последний снимок каждого сообщения', () => {
  const written = []
  let ready = false
  const { hub, connect, flush } = harness({
    write: (connection, event, payload) => {
      written.push({ connection: connection.id, event, payload })
      return ready
    },
  })
  const connection = connect('alpha', 'slow')

  hub.start('alpha', { messageId: 'narration-slow' })
  hub.progress('alpha', { messageId: 'narration-slow', text: 'Первое.' })
  flush()
  hub.progress('alpha', { messageId: 'narration-slow', text: 'Первое. Второе.' })
  flush()
  assert.equal(written.length, 1, 'start уже принят Node, следующие снимки объединены')

  ready = true
  hub.drain(connection)
  assert.equal(written.length, 2)
  assert.equal(written[1].payload.text, 'Первое. Второе.')
})

test('активные буферы и UTF-8 текст имеют жёсткие пределы', () => {
  const { hub, events, connect } = harness({ maxActive: 2 })
  connect('alpha', 'viewer')
  hub.start('alpha', { messageId: 'narration-1' })
  hub.start('alpha', { messageId: 'narration-2' })
  hub.start('alpha', { messageId: 'narration-3' })

  assert.equal(hub.activeCount('alpha'), 2)
  assert.equal(
    events.some((entry) => entry.payload.phase === 'aborted'),
    false,
    'вытеснение process-local preview не отменяет саму генерацию',
  )
  assert.throws(
    () => hub.progress('alpha', {
      messageId: 'narration-2',
      text: 'я'.repeat(Math.ceil(NARRATION_STREAM_TEXT_MAX_BYTES / 2) + 1),
    }),
    (error) => error?.code === 'NARRATION_STREAM_TOO_LARGE',
  )
  assert.equal(NARRATION_STREAM_MAX_ACTIVE_PER_CAMPAIGN, 16)
})

test('финал поддерживает complete, replaced и replayed без повторного start', () => {
  const { hub, events, connect } = harness()
  connect('alpha', 'viewer')

  hub.complete('alpha', {
    messageId: 'narration-replay',
    text: 'Канонический текст.',
    phase: 'complete',
    replayed: true,
  })
  hub.start('alpha', { messageId: 'narration-replaced' })
  hub.complete('alpha', {
    messageId: 'narration-replaced',
    text: 'Безопасная замена.',
    phase: 'replaced',
  })

  assert.deepEqual(events.map(({ event }) => event), [
    'narration.complete',
    'narration.start',
    'narration.complete',
  ])
  assert.equal(events[0].payload.replayed, true)
  assert.equal(events[2].payload.phase, 'replaced')
})

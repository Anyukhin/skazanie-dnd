import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAMPAIGN_STREAM_MAX_PENDING_FRAMES,
  CampaignNarrationStream,
  CampaignStreamOutbox,
  NARRATION_STREAM_EVENT_MAX_BYTES,
  NARRATION_STREAM_MAX_ACTIVE_PER_CAMPAIGN,
  NARRATION_STREAM_TEXT_MAX_BYTES,
  campaignStreamFrameKey,
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
  // Аудит PR #131, SEC-06: снимки повествования схлопывает общая очередь
  // соединения (`CampaignStreamOutbox`), та же, что держит `room` и `presence`.
  const written = []
  let ready = false
  const outboxes = new Map()
  const { hub, connect, flush } = harness({
    write: (connection, event, payload) => outboxes.get(connection.id).send(
      campaignStreamFrameKey(event, payload),
      () => {
        written.push({ connection: connection.id, event, payload })
        return `event: ${event}\n\n`
      },
    ),
  })
  connect('alpha', 'slow')
  const outbox = new CampaignStreamOutbox({ write: () => ready })
  outboxes.set('slow', outbox)

  hub.start('alpha', { messageId: 'narration-slow' })
  hub.progress('alpha', { messageId: 'narration-slow', text: 'Первое.' })
  flush()
  hub.progress('alpha', { messageId: 'narration-slow', text: 'Первое. Второе.' })
  flush()
  assert.equal(written.length, 1, 'start уже принят Node, следующие снимки объединены')
  assert.equal(outbox.pendingCount, 1)

  ready = true
  outbox.drain()
  assert.equal(written.length, 2)
  assert.equal(written[1].payload.text, 'Первое. Второе.')
  assert.equal(outbox.pendingCount, 0)
})

// ---------------------------------------------------------------------------
// Очередь соединения (аудит PR #131, SEC-06)
// ---------------------------------------------------------------------------

/**
 * Поддельный сокет: `ready` — что вернёт `res.write()`. Записанные строки
 * лежат в `chunks`; рендеры считают, сколько кадров вообще было собрано.
 */
function socket({ ready = true } = {}) {
  const chunks = []
  const state = { ready, closed: false, closeReasons: [] }
  const outbox = new CampaignStreamOutbox({
    write: (chunk) => {
      if (state.closed) return null
      chunks.push(chunk)
      return state.ready
    },
    onClose: (reason) => {
      state.closed = true
      state.closeReasons.push(reason)
    },
  })
  let renders = 0
  const send = (event, payload) => outbox.send(campaignStreamFrameKey(event, payload), () => {
    renders += 1
    return `event: ${event}\ndata: ${JSON.stringify(typeof payload === 'function' ? payload() : payload)}\n\n`
  })
  const frames = () => chunks.map((chunk) => ({
    event: /^event: (.+)$/mu.exec(chunk)?.[1],
    payload: JSON.parse(/^data: (.+)$/mu.exec(chunk)?.[1] ?? 'null'),
  }))
  return { outbox, state, send, frames, renders: () => renders }
}

test('быстрый поток не изменился: каждый кадр уходит сразу и по порядку', () => {
  const { outbox, send, frames, renders } = socket({ ready: true })
  assert.equal(send('room', { version: 1 }), true)
  assert.equal(send('presence', { typing_actor_ids: ['hero'] }), true)
  assert.equal(send('room', { version: 2 }), true)
  assert.equal(send('narration.chunk', { message_id: 'narration-a', text: 'Текст' }), true)
  assert.equal(send('room', { version: 3 }), true)
  assert.deepEqual(frames().map(({ event, payload }) => [event, payload.version ?? payload.text ?? payload.typing_actor_ids]), [
    ['room', 1], ['presence', ['hero']], ['room', 2], ['narration.chunk', 'Текст'], ['room', 3],
  ])
  assert.equal(renders(), 5, 'ничего не отложено и не выброшено')
  assert.equal(outbox.pendingCount, 0)
})

test('медленный читатель: room и presence схлопываются до последнего, очередь ограничена', () => {
  const { outbox, state, send, frames, renders } = socket({ ready: false })
  // Первый кадр Node принял в свой буфер и сообщил о переполнении.
  assert.equal(send('room', { version: 1 }), false)
  for (let version = 2; version <= 200; version += 1) {
    send('room', { version })
    send('presence', { typing_actor_ids: [`hero-${version}`] })
    outbox.send('heartbeat', () => ': heartbeat\n\n')
  }
  assert.equal(frames().length, 1, 'пока сокет занят, в него ничего не пишется')
  assert.equal(outbox.pendingCount, 3, 'одна комната, одно присутствие, один пульс — сколько бы ни набежало')
  assert.equal(renders(), 1, 'промежуточные кадры даже не собирались')

  // Сокет освободился: уходит последнее состояние, промежуточные схлопнуты.
  state.ready = true
  outbox.drain()
  assert.deepEqual(frames().map(({ event }) => event), ['room', 'room', 'presence', undefined])
  assert.equal(frames()[1].payload.version, 200)
  assert.deepEqual(frames()[2].payload.typing_actor_ids, ['hero-200'])
  assert.equal(outbox.pendingCount, 0)
  assert.deepEqual(state.closeReasons, [])
})

test('drain при снова занятом сокете отправляет по одному и ждёт следующего', () => {
  const { outbox, state, send, frames } = socket({ ready: false })
  send('room', { version: 1 })
  send('room', { version: 2 })
  send('narration.complete', { message_id: 'narration-a', text: 'Готово.' })
  outbox.drain()
  assert.equal(frames().length, 2, 'после записи, вернувшей false, очередь снова ждёт')
  assert.equal(frames()[1].payload.version, 2)
  assert.equal(outbox.pendingCount, 1)
  state.ready = true
  outbox.drain()
  assert.equal(frames()[2].payload.text, 'Готово.')
})

test('кадр собирается в момент записи: хеш карты — от того, что клиент получил', () => {
  // Схлопывание не должно оставить клиенту хеш карты, которую тот не получил:
  // поэтому кадр комнаты строится при записи, относительно `mapHash`,
  // который соединение действительно отправило (`broadcastCampaignRoom`).
  const { outbox, state, frames } = socket({ ready: false })
  const connection = { mapHash: '' }
  const room = (version, mapHash) => outbox.send('room', () => {
    const map = connection.mapHash === mapHash ? 'unchanged' : 'full'
    connection.mapHash = mapHash
    return `event: room\ndata: ${JSON.stringify({ version, map, map_hash: mapHash })}\n\n`
  })
  room(1, 'map-a')
  room(2, 'map-b')
  room(3, 'map-b')
  assert.equal(connection.mapHash, 'map-a', 'хеш не продвинут кадром, который ещё не ушёл')
  state.ready = true
  outbox.drain()
  const sent = frames().map(({ payload }) => payload)
  assert.deepEqual(sent.map(({ version }) => version), [1, 3])
  assert.equal(sent[1].map, 'full', 'вторая карта ушла целиком: промежуточный кадр с ней выброшен')
  assert.equal(connection.mapHash, 'map-b')
})

test('клиент, который не читает вовсе, закрывается, а не копит кадры', () => {
  const { outbox, state, send } = socket({ ready: false })
  send('room', { version: 1 })
  for (let index = 0; index < CAMPAIGN_STREAM_MAX_PENDING_FRAMES; index += 1) {
    send('narration.complete', { message_id: `narration-${index}`, text: 'Канонический текст.' })
  }
  assert.ok(outbox.pendingCount <= CAMPAIGN_STREAM_MAX_PENDING_FRAMES)
  assert.deepEqual(state.closeReasons, [])
  send('narration.complete', { message_id: 'narration-overflow', text: 'Ещё один.' })
  assert.deepEqual(state.closeReasons, ['overflow'], 'переподключение получит полное состояние рукопожатием')
  assert.equal(outbox.pendingCount, 0, 'память очереди освобождена')
  assert.equal(send('room', { version: 2 }), null, 'закрытое соединение больше ничего не принимает')
  assert.equal(outbox.pendingCount, 0)
})

test('отзыв прав выбрасывает непрочитанное, ошибка сборки на drain не роняет процесс', () => {
  const revoked = socket({ ready: false })
  revoked.send('room', { version: 1 })
  revoked.send('room', { version: 2, secret: 'собрано под прежними правами' })
  revoked.outbox.discard()
  revoked.state.ready = true
  revoked.outbox.drain()
  assert.equal(revoked.frames().length, 1)
  assert.equal(JSON.stringify(revoked.frames()).includes('прежними правами'), false)

  const broken = socket({ ready: false })
  broken.send('room', { version: 1 })
  broken.outbox.send('room', () => { throw new Error('проекция не собралась') })
  broken.state.ready = true
  assert.doesNotThrow(() => broken.outbox.drain())
  assert.deepEqual(broken.state.closeReasons, ['render_failed'])
})

test('ключ схлопывания: комната, присутствие, пульс и снимок своего сообщения', () => {
  assert.equal(campaignStreamFrameKey('room', {}), 'room')
  assert.equal(campaignStreamFrameKey('presence', {}), 'presence')
  assert.equal(campaignStreamFrameKey('narration.chunk', { message_id: 'a' }), 'narration:a')
  assert.equal(campaignStreamFrameKey('narration.complete', { message_id: 'a' }), 'narration:a')
  assert.equal(campaignStreamFrameKey('narration.chunk', { message_id: 'b' }), 'narration:b')
  assert.equal(campaignStreamFrameKey('access', { status: 'revoked' }), null)
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

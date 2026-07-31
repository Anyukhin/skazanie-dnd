import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const SSE_PAYLOAD_KEYS = ['message_id', 'phase', 'replace', 'replayed', 'text']

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function closeServer(server) {
  if (!server.listening) return
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function startGameServer({ port, storage, routerBaseUrl, appendLog }) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: 'narration-stream-test-key',
      ROUTERAI_BASE_URL: routerBaseUrl,
      DND_AI_MODEL: 'fake-stream-model',
      DND_AI_FALLBACK_MODELS: 'fake-stream-model',
      DND_AI_MODEL_TIMEOUT_MS: '5000',
      ADMIN_SETUP_TOKEN: 'narration-stream-setup',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopGameServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Game server did not stop')), 5_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited\n${logs()}`)
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return
    } catch { /* Сервер запускается. */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Server did not become healthy\n${logs()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : JSON_HEADERS),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* Ошибку покажет assert. */ }
  return { response, status: response.status, body: json, text }
}

const sessionCookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]
const narrationId = (key) => `narration-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`

async function openStream(baseUrl, campaignId, cookie, signal) {
  const response = await fetch(`${baseUrl}/api/campaigns/${campaignId}/stream`, {
    headers: { Cookie: cookie, Accept: 'text/event-stream' },
    signal,
  })
  assert.equal(response.status, 200)
  return {
    reader: response.body.getReader(),
    decoder: new TextDecoder(),
    buffer: '',
    queued: [],
  }
}

function queueSseBlocks(stream) {
  const blocks = stream.buffer.split(/\r?\n\r?\n/u)
  stream.buffer = blocks.pop() ?? ''
  for (const block of blocks) {
    const event = /^event: ([^\r\n]+)$/mu.exec(block)?.[1] ?? ''
    const data = block.split(/\r?\n/u)
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('\n')
    if (!event || !data) continue
    stream.queued.push({ event, payload: JSON.parse(data) })
  }
}

async function nextSseEvent(stream, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    while (stream.queued.length) {
      const value = stream.queued.shift()
      if (predicate(value)) return value
    }
    const remaining = Math.max(1, deadline - Date.now())
    let timeout
    const read = await Promise.race([
      stream.reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('SSE timeout')), remaining)
      }),
    ]).finally(() => clearTimeout(timeout))
    if (read.done) throw new Error('SSE stream closed')
    stream.buffer += stream.decoder.decode(read.value, { stream: true })
    queueSseBlocks(stream)
  }
  throw new Error('No matching SSE event')
}

const nextNarration = (stream, messageId, phase = null, timeoutMs) => nextSseEvent(
  stream,
  ({ event, payload }) => event.startsWith('narration.')
    && payload.message_id === messageId
    && (!phase || payload.phase === phase),
  timeoutMs,
)

function assertPublicNarrationPayload(payload) {
  assert.deepEqual(Object.keys(payload).sort(), SSE_PAYLOAD_KEYS)
  assert.equal(payload.replace, true)
  assert.equal(Object.hasOwn(payload, 'room_version'), false)
  assert.equal(Object.hasOwn(payload, 'authoritative_state'), false)
  assert.equal(Object.hasOwn(payload, 'mechanics'), false)
  assert.equal(Object.hasOwn(payload, 'idempotency_key'), false)
}

function hero(id, character) {
  return {
    id,
    character,
    name: character,
    hp: 100,
    maxHp: 100,
    armor: 12,
    speed: 30,
    proficiency: 2,
    abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    inventory: [],
  }
}

function campaignState(code) {
  return {
    sessionCode: code,
    campaign: `Поток ${code}`,
    activePlayerId: 'hero-1',
    partyMemberIds: ['hero-1', 'hero-2'],
    messages: [],
    players: [
      hero('hero-1', 'Ада'),
      hero('hero-2', 'Бранн'),
      hero('goblin', 'Гоблин'),
    ],
    scene: {
      title: 'Зал',
      location: 'Зал',
      mood: '',
      objective: '',
      turn: 1,
      cells: [],
    },
    adventure: { chapter: 1, visitedLocations: ['Зал'], history: [] },
    ruleset_id: 'srd_5_2_1',
    ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'],
    state_version: 0,
  }
}

function writeDelta(res, text) {
  res.write(`data: ${JSON.stringify({
    model: 'fake-stream-model',
    choices: [{ delta: { content: text } }],
  })}\n\n`)
}

function finishStream(res, text = '') {
  if (text) writeDelta(res, text)
  res.write(`data: ${JSON.stringify({
    model: 'fake-stream-model',
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  })}\n\n`)
  res.end('data: [DONE]\n\n')
}

test('HTTP/SSE повествование изолировано, восстанавливается и завершается канонически', { timeout: 90_000 }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-narration-stream-api-'))
  let logs = ''
  let child = null
  const aborters = []
  let streamCalls = 0
  let releaseFirst
  let firstStarted
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const firstRequest = new Promise((resolve) => { firstStarted = resolve })
  let releaseDisconnected
  let disconnectedStarted
  const disconnectedGate = new Promise((resolve) => { releaseDisconnected = resolve })
  const disconnectedRequest = new Promise((resolve) => { disconnectedStarted = resolve })

  const fakeRouter = createHttpServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/v1/chat/completions') {
      res.writeHead(404, JSON_HEADERS)
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { raw += chunk })
    req.once('end', async () => {
      const input = JSON.parse(raw)
      if (!input.stream) {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({
          model: 'fake-stream-model',
          choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }],
        }))
        return
      }
      streamCalls += 1
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      })
      if (streamCalls === 1) {
        writeDelta(res, 'Подтверждённый удар достигает цели.')
        firstStarted()
        await firstGate
        finishStream(res, ' Схватка продолжается.')
        return
      }
      if (streamCalls === 2) {
        writeDelta(res, 'На миг всё стихает.')
        setTimeout(() => res.destroy(), 80)
        return
      }
      if (streamCalls === 3) {
        finishStream(res, 'Герой получает 999 HP.')
        return
      }
      writeDelta(res, 'Подтверждённый удар достигает цели.')
      disconnectedStarted()
      await disconnectedGate
      finishStream(res, ' Схватка продолжается.')
    })
  })

  t.after(async () => {
    releaseFirst()
    releaseDisconnected()
    for (const controller of aborters) controller.abort()
    await stopGameServer(child)
    await closeServer(fakeRouter)
    rmSync(storage, { recursive: true, force: true })
  })

  const routerPort = await listen(fakeRouter)
  const gamePort = await freePort()
  const baseUrl = `http://127.0.0.1:${gamePort}`
  child = startGameServer({
    port: gamePort,
    storage,
    routerBaseUrl: `http://127.0.0.1:${routerPort}/api/v1`,
    appendLog: (chunk) => { logs += chunk },
  })
  await waitForHealth(baseUrl, child, () => logs)

  const owner = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: {
      name: 'Owner',
      email: 'stream-owner@test.local',
      password: 'secure-owner-password',
      setupToken: 'narration-stream-setup',
    },
  })
  assert.equal(owner.status, 201, owner.text)
  const guest = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Guest',
      email: 'stream-guest@test.local',
      password: 'secure-guest-password',
    },
  })
  assert.equal(guest.status, 201, guest.text)
  const ownerCookie = sessionCookie(owner)
  const guestCookie = sessionCookie(guest)

  for (const code of ['STREAMA', 'STREAMB']) {
    const created = await request(baseUrl, '/api/campaigns', {
      method: 'POST',
      cookie: ownerCookie,
      body: { code, state: campaignState(code) },
    })
    assert.equal(created.status, 201, created.text)
  }
  const invite = await request(baseUrl, '/api/campaigns/STREAMA/invites', {
    method: 'POST',
    cookie: ownerCookie,
    body: { hero_ids: ['hero-2'] },
  })
  assert.equal(invite.status, 201, invite.text)
  const joined = await request(baseUrl, '/api/campaigns/STREAMA/join', {
    method: 'POST',
    cookie: guestCookie,
    body: { invite_token: invite.body.token },
  })
  assert.equal(joined.status, 200, joined.text)
  const unauthorized = await request(baseUrl, '/api/campaigns/STREAMB/stream', {
    cookie: guestCookie,
  })
  assert.equal(unauthorized.status, 403, unauthorized.text)

  const ownerAbort = new AbortController()
  const guestAbort = new AbortController()
  const otherAbort = new AbortController()
  aborters.push(ownerAbort, guestAbort, otherAbort)
  const ownerStream = await openStream(baseUrl, 'STREAMA', ownerCookie, ownerAbort.signal)
  const guestStream = await openStream(baseUrl, 'STREAMA', guestCookie, guestAbort.signal)
  const otherStream = await openStream(baseUrl, 'STREAMB', ownerCookie, otherAbort.signal)

  const duplicateKey = 'stream-duplicate'
  const duplicateMessageId = narrationId(duplicateKey)
  const actionBody = {
    campaign_id: 'STREAMA',
    actor_id: 'hero-1',
    action: 'Атакую Гоблина',
    idempotency_key: duplicateKey,
  }
  const firstResponse = request(baseUrl, '/api/narrate', {
    method: 'POST',
    cookie: ownerCookie,
    body: actionBody,
  })
  await firstRequest
  const replayResponse = request(baseUrl, '/api/narrate', {
    method: 'POST',
    cookie: ownerCookie,
    body: actionBody,
  })

  const ownerStart = await nextNarration(ownerStream, duplicateMessageId, 'start')
  const guestStart = await nextNarration(guestStream, duplicateMessageId, 'start')
  assertPublicNarrationPayload(ownerStart.payload)
  assertPublicNarrationPayload(guestStart.payload)

  const ownerChunk = await nextNarration(ownerStream, duplicateMessageId, 'streaming')
  const guestChunk = await nextNarration(guestStream, duplicateMessageId, 'streaming')
  assert.equal(ownerChunk.payload.text, 'Подтверждённый удар достигает цели.')
  assert.equal(guestChunk.payload.text, ownerChunk.payload.text)

  const reconnectAbort = new AbortController()
  aborters.push(reconnectAbort)
  const reconnectStream = await openStream(baseUrl, 'STREAMA', guestCookie, reconnectAbort.signal)
  const reconnected = await nextNarration(reconnectStream, duplicateMessageId, 'streaming')
  assert.equal(reconnected.payload.text, ownerChunk.payload.text)
  assertPublicNarrationPayload(reconnected.payload)

  releaseFirst()
  const [first, replay] = await Promise.all([firstResponse, replayResponse])
  assert.equal(first.status, 200, `${first.text}\n${logs}`)
  assert.equal(replay.status, 200, `${replay.text}\n${logs}`)
  assert.equal(first.body.narration, replay.body.narration)
  assert.equal(first.body.narration_message_id, duplicateMessageId)
  assert.deepEqual(
    [Boolean(first.body.idempotent_replay), Boolean(replay.body.idempotent_replay)].sort(),
    [false, true],
  )
  assert.equal(streamCalls, 1)

  const duplicateFinals = [
    await nextNarration(ownerStream, duplicateMessageId, 'complete'),
    await nextNarration(ownerStream, duplicateMessageId, 'complete'),
  ]
  assert.deepEqual(duplicateFinals.map((entry) => entry.payload.replayed).sort(), [false, true])
  for (const final of duplicateFinals) {
    assert.equal(final.payload.text, first.body.narration)
    assertPublicNarrationPayload(final.payload)
  }

  const roomAfterDuplicate = await request(baseUrl, '/api/rooms/STREAMA', { cookie: ownerCookie })
  assert.equal(
    roomAfterDuplicate.body.state.messages.filter((message) => message.id === duplicateMessageId).length,
    1,
    'параллельный replay не дублирует каноническую летопись',
  )

  const replacementKey = 'stream-provider-fallback'
  const replacementId = narrationId(replacementKey)
  const replacementResponse = request(baseUrl, '/api/narrate', {
    method: 'POST',
    cookie: ownerCookie,
    body: { ...actionBody, idempotency_key: replacementKey },
  })
  await nextNarration(ownerStream, replacementId, 'start')
  const replacementChunk = await nextNarration(ownerStream, replacementId, 'streaming')
  assert.equal(replacementChunk.payload.text, 'На миг всё стихает.')
  const replacementFinal = await nextNarration(ownerStream, replacementId, 'replaced')
  const replacementResult = await replacementResponse
  assert.equal(replacementResult.status, 200, `${replacementResult.text}\n${logs}`)
  assert.equal(replacementFinal.payload.text, replacementResult.body.narration)
  assert.notEqual(replacementFinal.payload.text, replacementChunk.payload.text)
  assertPublicNarrationPayload(replacementFinal.payload)

  const safetyKey = 'stream-safety-fallback'
  const safetyId = narrationId(safetyKey)
  const safetyResponse = request(baseUrl, '/api/narrate', {
    method: 'POST',
    cookie: ownerCookie,
    body: { ...actionBody, idempotency_key: safetyKey },
  })
  await nextNarration(ownerStream, safetyId, 'start')
  const safetyFinal = await nextNarration(ownerStream, safetyId, 'complete')
  const safetyResult = await safetyResponse
  assert.equal(safetyResult.status, 200, `${safetyResult.text}\n${logs}`)
  assert.equal(safetyFinal.payload.text, safetyResult.body.narration)
  assert.equal(JSON.stringify(safetyFinal.payload).includes('999'), false)
  assertPublicNarrationPayload(safetyFinal.payload)

  await assert.rejects(
    nextSseEvent(otherStream, ({ event }) => event.startsWith('narration.'), 350),
    /SSE timeout/u,
    'другая кампания не должна получать поток текста',
  )

  const disconnectedKey = 'stream-disconnected-post'
  const disconnectedId = narrationId(disconnectedKey)
  const postAbort = new AbortController()
  const disconnectedFetch = fetch(`${baseUrl}/api/narrate`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, Cookie: ownerCookie },
    body: JSON.stringify({ ...actionBody, idempotency_key: disconnectedKey }),
    signal: postAbort.signal,
  }).catch((error) => error)
  await disconnectedRequest
  await nextNarration(ownerStream, disconnectedId, 'start')
  await nextNarration(ownerStream, disconnectedId, 'streaming')
  postAbort.abort()
  releaseDisconnected()
  const disconnectedFinal = await nextNarration(ownerStream, disconnectedId, 'complete')
  assertPublicNarrationPayload(disconnectedFinal.payload)
  await disconnectedFetch

  const journalDeadline = Date.now() + 5_000
  let disconnectedJournal = null
  while (Date.now() < journalDeadline && !disconnectedJournal) {
    const room = await request(baseUrl, '/api/rooms/STREAMA', { cookie: ownerCookie })
    disconnectedJournal = room.body.state.messages.find((message) => message.id === disconnectedId) ?? null
    if (!disconnectedJournal) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(disconnectedJournal, 'разрыв HTTP-клиента не отменяет финальную запись летописи')
  assert.equal(disconnectedJournal.text, disconnectedFinal.payload.text)
})

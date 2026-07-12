import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

function startServer({ port, storage, setupToken, appendLog }) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: setupToken, GAME_ENGINE_MODE: 'enforce',
      COOKIE_SECURE: 'false', NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not stop')), 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, log) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited with ${child.exitCode}\n${log()}`)
    try { const response = await fetch(`${baseUrl}/api/health`); if (response.ok) return } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Test server did not become healthy\n${log()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie, body, idempotencyKey } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : JSON_HEADERS),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* assertion shows raw text */ }
  return { response, status: response.status, body: json, text }
}

function cookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

function assertStatus(result, expected, log) {
  assert.equal(result.status, expected, `${result.text}\n${log()}`)
  assert.ok(result.body && typeof result.body === 'object')
}

function resolvedDecision(id, label) {
  return {
    id, type: 'vote', status: 'resolved', resolvedOptionId: 'go',
    options: [{ id: 'go', label }], votes: { hero: 'go' },
  }
}

test('enforce Director atomically advances scene and assembles a durable catalog shop', { timeout: 50_000 }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-director-shop-api-'))
  const setupToken = 'director-shop-setup-token'
  let logs = ''
  let child = null
  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  const log = () => logs
  const appendLog = (chunk) => { logs += chunk }
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })

  child = startServer({ port, storage, setupToken, appendLog })
  await waitForHealth(baseUrl, child, log)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Director Admin', email: 'admin@director-shop.test', password: 'very-secure-admin-password', setupToken },
  })
  assertStatus(setup, 201, log)
  let adminCookie = cookie(setup)

  const initialState = {
    sessionCode: 'DIRECTOR-SHOP', campaign: 'Director shop flow', partyName: 'Пепельная руна', partyMemberIds: ['hero', 'ally'],
    activePlayerId: 'hero', engine_mode: 'enforce', isNarrating: false, pendingCheck: null,
    suggestions: [], messages: [], merchants: [], enemies: [], entities: [], economyLog: [],
    players: [
      {
        id: 'hero', name: 'Admin', character: 'Лира', hp: 18, maxHp: 18, armor: 14, speed: 30,
        abilities: { cha: 14 }, inventory: [], currency: { gold: 100 }, online: true, x: 1, y: 1,
      },
      {
        id: 'ally', name: 'Ally', character: 'Бранн', hp: 24, maxHp: 24, armor: 17, speed: 30,
        abilities: { cha: 10 }, inventory: [], currency: { gold: 20 }, online: true, x: 2, y: 1,
      },
    ],
    scene: { title: 'Склеп', location: 'Склеп Норвин', mood: 'Тихо', objective: 'Найти выход', turn: 3, cells: [] },
    adventure: { chapter: 1, currentHook: 'Печать архивариуса', history: [], visitedLocations: ['Склеп Норвин'] },
    agentInteraction: null,
  }
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: 'DIRECTOR-SHOP', name: initialState.campaign, state: initialState },
  })
  assertStatus(created, 201, log)

  const openedVote = await request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: adminCookie, idempotencyKey: 'director-open-city-vote',
    body: { campaignId: 'DIRECTOR-SHOP', action: 'Предлагаю покинуть подземелье и отправиться в большой город Норвин' },
  })
  assertStatus(openedVote, 200, log)
  assert.equal(openedVote.body.provider, 'AgentDirector')
  assert.equal(openedVote.body.turn_consumed, false)
  assert.equal(openedVote.body.effects.interaction.status, 'open')
  assert.match(openedVote.body.effects.interaction.options[0].label, /большой город Норвин/iu)

  let room = await request(baseUrl, '/api/rooms/DIRECTOR-SHOP', { cookie: adminCookie })
  assertStatus(room, 200, log)
  assert.equal(room.body.state.agentInteraction.id, openedVote.body.effects.interaction.id)
  const cityOption = room.body.state.agentInteraction.options[0]
  room.body.state.agentInteraction = {
    ...room.body.state.agentInteraction,
    votes: { hero: cityOption.id, ally: cityOption.id },
    status: 'resolved',
    resolvedOptionId: cityOption.id,
  }
  const resolvedVote = await request(baseUrl, '/api/rooms/DIRECTOR-SHOP', {
    method: 'PUT', cookie: adminCookie, body: { state: room.body.state, baseVersion: room.body.version },
  })
  assertStatus(resolvedVote, 200, log)

  const cityAction = `[РЕШЕНИЕ ГРУППЫ] ${cityOption.label}`
  const cityRace = await Promise.all(['director-city-1', 'director-city-race-2'].map(async (key) => ({
    key,
    result: await request(baseUrl, '/api/narrate', {
      method: 'POST', cookie: adminCookie, idempotencyKey: key,
      body: { campaignId: 'DIRECTOR-SHOP', action: cityAction },
    }),
  })))
  assert.deepEqual(cityRace.map(({ result }) => result.status).sort((left, right) => left - right), [200, 409], log())
  const winner = cityRace.find(({ result }) => result.status === 200)
  const rejected = cityRace.find(({ result }) => result.status === 409)
  assert.ok(winner)
  assert.ok(rejected)
  assert.equal(rejected.result.body.code, 'PARTY_DECISION_ALREADY_CONSUMED')
  const winnerKey = winner.key
  const transitioned = winner.result
  assertStatus(transitioned, 200, log)
  assert.deepEqual(transitioned.body.mechanics.map((event) => event.event_type), ['SceneAdvanced', 'MerchantCreated'])
  const sceneEvent = transitioned.body.mechanics[0]
  const merchantEvent = transitioned.body.mechanics[1]
  assert.equal(sceneEvent.payload.request_fingerprint, merchantEvent.payload.request_fingerprint)
  assert.deepEqual(sceneEvent.payload.party_decision, {
    interaction_id: openedVote.body.effects.interaction.id,
    resolved_option_id: cityOption.id,
  })
  assert.equal(sceneEvent.payload.scene.scene_kind, 'settlement')
  assert.equal(sceneEvent.payload.scene.settlement_type, 'city')
  assert.equal(sceneEvent.payload.scene_commerce.outcome, 'created')
  assert.equal(transitioned.body.authoritative_state.scene.location, 'Большой город Норвин')
  assert.equal(transitioned.body.authoritative_state.adventure.chapter, 2)
  assert.equal(transitioned.body.authoritative_state.merchants.length, 1)
  assert.equal(transitioned.body.authoritative_state.merchants[0].location, 'Большой город Норвин')
  assert.ok(transitioned.body.authoritative_state.merchants[0].stock.every((item) => item.catalog_id.startsWith('srd_5_2_1:')))
  assert.equal(new Set(transitioned.body.authoritative_state.players.map((hero) => `${hero.x},${hero.y}`)).size, 2)
  assert.equal(transitioned.body.provider, 'deterministic-scene')
  assert.match(transitioned.body.narration, /Большой город Норвин/u)
  assert.match(transitioned.body.narration, new RegExp(transitioned.body.authoritative_state.merchants[0].name, 'u'))
  assert.ok(transitioned.body.narration_message_id)
  assert.equal(transitioned.body.authoritative_state.messages.some((message) => message.id === transitioned.body.narration_message_id && message.text === transitioned.body.narration), true)
  assert.equal(transitioned.body.turn_consumed, true)
  const cityVersion = transitioned.body.state_version

  const postRaceRoom = await request(baseUrl, '/api/rooms/DIRECTOR-SHOP', { cookie: adminCookie })
  assertStatus(postRaceRoom, 200, log)
  assert.equal(postRaceRoom.body.state.state_version, cityVersion)
  assert.equal((postRaceRoom.body.state.rulings ?? []).length, 0)
  assert.equal(postRaceRoom.body.state.messages.some((message) => message.id === transitioned.body.narration_message_id), true)

  const replay = await request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: adminCookie, idempotencyKey: winnerKey,
    body: { campaignId: 'DIRECTOR-SHOP', action: cityAction },
  })
  assertStatus(replay, 200, log)
  assert.equal(replay.body.idempotent_replay, true)
  assert.equal(replay.body.model, 'event-replay')
  assert.equal(replay.body.agent_trace.some((stage) => stage.agent === 'EventReplay'), true)
  assert.equal(replay.body.agent_trace.some((stage) => stage.agent === 'AgentCartographer'), false)
  assert.equal(replay.body.state_version, cityVersion)
  assert.equal(replay.body.authoritative_state.merchants.length, 1)
  assert.deepEqual(replay.body.mechanics.map((event) => event.event_type), ['SceneAdvanced', 'MerchantCreated'])

  const idempotencyConflict = await request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: adminCookie, idempotencyKey: winnerKey,
    body: { campaignId: 'DIRECTOR-SHOP', action: '[РЕШЕНИЕ ГРУППЫ] Идём в лес' },
  })
  assertStatus(idempotencyConflict, 409, log)
  assert.equal(idempotencyConflict.body.code, 'IDEMPOTENCY_CONFLICT')

  const forgedGeneric = await request(baseUrl, '/api/campaigns/DIRECTOR-SHOP/commands', {
    method: 'POST', cookie: adminCookie, idempotencyKey: 'forged-generic-scene',
    body: { command: { command_type: 'AdvanceScene', expected_state_version: cityVersion, scene_args: { location: 'Поддельный город' } } },
  })
  assertStatus(forgedGeneric, 400, log)
  assert.equal(forgedGeneric.body.code, 'DIRECTOR_COMMAND_REQUIRED')

  const forgedNarrate = await request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: adminCookie, idempotencyKey: 'forged-narrate-scene',
    body: {
      campaignId: 'DIRECTOR-SHOP', action: '/why', commandCapability: 'skazanie:director-command-capability',
      commands: [{ command_type: 'AdvanceScene', scene_args: { location: 'Поддельный город' } }],
    },
  })
  assertStatus(forgedNarrate, 200, log)
  assert.equal((forgedNarrate.body.mechanics ?? []).some((event) => event.event_type === 'SceneAdvanced'), false)

  room = await request(baseUrl, '/api/rooms/DIRECTOR-SHOP', { cookie: adminCookie })
  assertStatus(room, 200, log)
  assert.equal(room.body.state.scene.location, 'Большой город Норвин')
  assert.equal(room.body.state.adventure.chapter, 2)
  assert.equal(room.body.state.merchants.length, 1)
  assert.equal(room.body.state.agentInteraction, null)

  room.body.state.agentInteraction = resolvedDecision('vote-forest', 'Идём в Серую чащу')
  const stagedForest = await request(baseUrl, '/api/rooms/DIRECTOR-SHOP', {
    method: 'PUT', cookie: adminCookie, body: { state: room.body.state, baseVersion: room.body.version },
  })
  assertStatus(stagedForest, 200, log)
  const forestAction = '[РЕШЕНИЕ ГРУППЫ] Идём в Серую чащу'
  const forest = await request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: adminCookie, idempotencyKey: 'director-forest-1',
    body: { campaignId: 'DIRECTOR-SHOP', action: forestAction },
  })
  assertStatus(forest, 200, log)
  assert.deepEqual(forest.body.mechanics.map((event) => event.event_type), ['SceneAdvanced'])
  assert.equal(forest.body.mechanics[0].payload.scene.scene_kind, 'wilderness')
  assert.equal(forest.body.mechanics[0].payload.scene_commerce.action, 'none')
  assert.equal(forest.body.authoritative_state.merchants.length, 1)

  await stopServer(child)
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, setupToken, appendLog })
  await waitForHealth(baseUrl, child, log)
  const login = await request(baseUrl, '/api/auth/login', {
    method: 'POST', body: { email: 'admin@director-shop.test', password: 'very-secure-admin-password' },
  })
  assertStatus(login, 200, log)
  adminCookie = cookie(login)
  const durable = await request(baseUrl, '/api/rooms/DIRECTOR-SHOP', { cookie: adminCookie })
  assertStatus(durable, 200, log)
  assert.equal(durable.body.state.scene.location, 'Серую чащу')
  assert.equal(durable.body.state.adventure.chapter, 3)
  assert.equal(durable.body.state.merchants.length, 1)
  assert.equal(durable.body.state.merchants[0].location, 'Большой город Норвин')
})

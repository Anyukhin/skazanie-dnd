import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileEventStore } from '../server/event-store.mjs'
import { resolvePartyVote } from '../server/party-decision.mjs'
import { GAME_STATE_PROJECTOR_VERSION, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

async function freePort() {
  const probe = await new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: 'quest-abandonment-setup',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve) => {
    child.once('exit', resolve)
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Тестовый сервер завершился\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* сервер ещё запускается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Тестовый сервер не запустился\n${logs()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body, key = '' } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(key ? { 'X-Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text }
}

function sessionCookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

function quest(id, title, visibility = 'party') {
  return {
    id,
    title,
    summary: title,
    status: 'active',
    visibility,
    entity_ids: [],
    objectives: [title],
    clock: { current: 0, max: 4, label: 'Срок' },
  }
}

function campaignState() {
  return {
    sessionCode: 'QUEST-ABANDON',
    campaign: 'Отказ от задания',
    activePlayerId: 'hero-a',
    partyMemberIds: ['hero-a', 'hero-b'],
    players: [
      { id: 'hero-a', character: 'Лира', hp: 10, maxHp: 10, armor: 14, abilities: {}, proficiency: 2, inventory: [], online: true, x: 2, y: 3 },
      { id: 'hero-b', character: 'Бранн', hp: 12, maxHp: 12, armor: 16, abilities: {}, proficiency: 2, inventory: [], online: true, x: 5, y: 4 },
    ],
    scene: {
      title: 'Старая сцена',
      location: 'Старый город',
      objective: 'Доставить вторую реликвию',
      mood: 'Тихий вечер',
      turn: 3,
      cells: [],
    },
    adventure: {
      chapter: 1,
      currentHook: 'Доставить вторую реликвию',
      visitedLocations: ['Старый город'],
      history: [],
    },
    mechanics: {
      positions: { 'hero-a': { x: 2, y: 3 }, 'hero-b': { x: 5, y: 4 } },
      world_time: { amount: 42, unit: 'minute', elapsed_minutes: 42 },
      combat: { active: false },
    },
    worldMemory: {
      quests: [
        quest('quest:first', 'Первая возможность'),
        quest('quest:second', 'Доставить вторую реликвию'),
        quest('quest:secret', 'Тайное поручение', 'gm_only'),
      ],
    },
  }
}

function stateFrom(result) {
  assert.ok(result.body?.state, result.text)
  return result.body.state
}

function questFrom(state, id) {
  return state.worldMemory?.quests?.find((entry) => entry.id === id)
}

async function waitForRoom(baseUrl, cookie, child, logs, predicate) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const room = await request(baseUrl, '/api/rooms/QUEST-ABANDON', { cookie })
    if (room.status === 200 && predicate(room.body?.state)) return room
    if (child.exitCode != null) throw new Error(`Тестовый сервер завершился\n${logs()}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Состояние кампании не достигло ожидаемого результата\n${logs()}`)
}

test('отказ от выбранного задания остаётся в сцене, голосуется всей группой и переживает replay/restart', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-quest-abandonment-'))
  let logs = ''
  let child = null
  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Admin', email: 'quest-admin@test.local', password: 'very-secure-password', setupToken: 'quest-abandonment-setup' },
  })
  assert.equal(admin.status, 201, admin.text)
  const adminCookie = sessionCookie(admin)
  const guest = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Guest', email: 'quest-guest@test.local', password: 'another-secure-password' },
  })
  assert.equal(guest.status, 201, guest.text)
  const guestCookie = sessionCookie(guest)
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  assert.equal(users.status, 200, users.text)
  const guestUser = users.body.users.find((user) => user.email === 'quest-guest@test.local')
  assert.ok(guestUser)
  const assigned = await request(baseUrl, `/api/admin/users/${guestUser.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { heroIds: ['hero-b'] },
  })
  assert.equal(assigned.status, 200, assigned.text)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: adminCookie,
    body: { code: 'QUEST-ABANDON', state: campaignState() },
  })
  assert.equal(created.status, 201, created.text)
  const before = stateFrom(await request(baseUrl, '/api/rooms/QUEST-ABANDON', { cookie: adminCookie }))
  const beforeLocation = before.scene.location
  const beforeTime = before.mechanics.world_time.elapsed_minutes
  const beforePositions = Object.fromEntries(before.players.map((player) => [player.id, { x: player.x, y: player.y }]))

  const abandonPath = '/api/campaigns/QUEST-ABANDON/quests/abandon'
  const open = await request(baseUrl, abandonPath, {
    method: 'POST',
    cookie: adminCookie,
    body: { actor_id: 'hero-a', quest_id: 'quest:second', idempotency_key: 'abandon-second-1' },
  })
  assert.equal(open.status, 200, open.text)
  const openState = stateFrom(open)
  const interaction = openState.agentInteraction
  assert.equal(interaction.questAbandonment?.schemaVersion, 1)
  assert.equal(interaction.questAbandonment?.questId, 'quest:second')
  assert.deepEqual(interaction.options.map((option) => option.id), ['keep', 'abandon'])

  const repeatedOpen = await request(baseUrl, abandonPath, {
    method: 'POST',
    cookie: adminCookie,
    body: { actor_id: 'hero-a', quest_id: 'quest:second', idempotency_key: 'abandon-second-1' },
  })
  assert.equal(repeatedOpen.status, 200, repeatedOpen.text)
  assert.equal(stateFrom(repeatedOpen).agentInteraction.id, interaction.id)

  const differentTarget = await request(baseUrl, abandonPath, {
    method: 'POST',
    cookie: adminCookie,
    body: { actor_id: 'hero-a', quest_id: 'quest:first', idempotency_key: 'abandon-second-1' },
  })
  assert.equal(differentTarget.body?.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal(differentTarget.response.ok, false)

  const secret = await request(baseUrl, abandonPath, {
    method: 'POST',
    cookie: adminCookie,
    body: { actor_id: 'hero-a', quest_id: 'quest:secret', idempotency_key: 'abandon-secret-1' },
  })
  assert.equal(secret.body?.code, 'WORLD_QUEST_NOT_FOUND')
  assert.equal(secret.response.ok, false)

  const ownership = await request(baseUrl, abandonPath, {
    method: 'POST',
    cookie: guestCookie,
    body: { actor_id: 'hero-a', quest_id: 'quest:first', idempotency_key: 'abandon-foreign-1' },
  })
  assert.equal(ownership.status, 403, ownership.text)
  assert.equal(ownership.body?.code, 'ACTOR_FORBIDDEN')

  const votePath = `/api/campaigns/QUEST-ABANDON/party-decisions/${encodeURIComponent(interaction.id)}/votes`
  const firstVote = await request(baseUrl, votePath, {
    method: 'POST',
    cookie: adminCookie,
    body: { actor_id: 'hero-a', option_id: 'abandon', idempotency_key: 'abandon-vote-a' },
  })
  assert.equal(firstVote.status, 200, firstVote.text)
  assert.equal(stateFrom(firstVote).agentInteraction.status, 'open')

  const voteOptionConflict = await request(baseUrl, votePath, {
    method: 'POST',
    cookie: adminCookie,
    body: { actor_id: 'hero-a', option_id: 'keep', idempotency_key: 'abandon-vote-a' },
  })
  assert.equal(voteOptionConflict.status, 409, voteOptionConflict.text)
  assert.equal(voteOptionConflict.body?.code, 'IDEMPOTENCY_CONFLICT')
  const voteActorConflict = await request(baseUrl, votePath, {
    method: 'POST',
    cookie: guestCookie,
    body: { actor_id: 'hero-b', option_id: 'abandon', idempotency_key: 'abandon-vote-a' },
  })
  assert.equal(voteActorConflict.status, 409, voteActorConflict.text)
  assert.equal(voteActorConflict.body?.code, 'IDEMPOTENCY_CONFLICT')

  const secondVote = await request(baseUrl, votePath, {
    method: 'POST',
    cookie: guestCookie,
    body: { actor_id: 'hero-b', option_id: 'abandon', idempotency_key: 'abandon-vote-b' },
  })
  assert.equal(secondVote.status, 200, secondVote.text)

  const finished = await waitForRoom(baseUrl, adminCookie, child, () => logs, (state) => (
    state?.agentInteraction == null && questFrom(state, 'quest:second')?.status === 'abandoned'
  ))
  const after = finished.body.state
  assert.equal(questFrom(after, 'quest:first')?.status, 'active')
  assert.equal(questFrom(after, 'quest:second')?.status, 'abandoned')
  assert.equal(after.scene.location, beforeLocation)
  assert.equal(after.mechanics.world_time.elapsed_minutes, beforeTime)
  assert.deepEqual(Object.fromEntries(after.players.map((player) => [player.id, { x: player.x, y: player.y }])), beforePositions)

  const hint = await request(baseUrl, '/api/narrate', {
    method: 'POST',
    cookie: adminCookie,
    body: { campaignId: 'QUEST-ABANDON', action: 'Куда идти дальше?', request_kind: 'question', idempotency_key: 'abandon-next-hint' },
  })
  assert.equal(hint.status, 200, hint.text)
  assert.doesNotMatch(String(hint.body?.narration ?? ''), /Доставить вторую реликвию/u)
  assert.match(String(hint.body?.narration ?? ''), /текущая задача|занятие|новая цель/iu)

  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)
  const restarted = stateFrom(await request(baseUrl, '/api/rooms/QUEST-ABANDON', { cookie: adminCookie }))
  assert.equal(restarted.agentInteraction, null)
  assert.equal(questFrom(restarted, 'quest:second')?.status, 'abandoned')
  assert.equal(restarted.scene.location, beforeLocation)
  assert.equal(restarted.mechanics.world_time.elapsed_minutes, beforeTime)
  assert.deepEqual(Object.fromEntries(restarted.players.map((player) => [player.id, { x: player.x, y: player.y }])), beforePositions)

  // Второй сценарий моделирует crash boundary: после первого голоса сервер
  // оставляет resolved PartyDecision в event store, а процесс падает до finish.
  const crashOpen = await request(baseUrl, abandonPath, {
    method: 'POST',
    cookie: adminCookie,
    body: { actor_id: 'hero-a', quest_id: 'quest:first', idempotency_key: 'abandon-first-crash' },
  })
  assert.equal(crashOpen.status, 200, crashOpen.text)
  const crashInteraction = stateFrom(crashOpen).agentInteraction
  const crashVotePath = `/api/campaigns/QUEST-ABANDON/party-decisions/${encodeURIComponent(crashInteraction.id)}/votes`
  const crashFirstVote = await request(baseUrl, crashVotePath, {
    method: 'POST',
    cookie: adminCookie,
    body: { actor_id: 'hero-a', option_id: 'abandon', idempotency_key: 'crash-vote-a' },
  })
  assert.equal(crashFirstVote.status, 200, crashFirstVote.text)
  assert.equal(stateFrom(crashFirstVote).agentInteraction.status, 'open')

  await stopServer(child)
  child = null
  const eventStore = new FileEventStore({
    rootDir: join(storage, 'engine'),
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
  })
  const beforeCrashFinish = await eventStore.load('QUEST-ABANDON')
  const crashResolution = resolvePartyVote(beforeCrashFinish.state, {
    interactionId: crashInteraction.id,
    heroId: 'hero-b',
    optionId: 'abandon',
    eligibleHeroIds: ['hero-a', 'hero-b'],
  })
  assert.deepEqual(crashResolution.events.map((event) => event.event_type), ['PartyVoteCast', 'PartyDecisionResolved'])
  await eventStore.commit({
    campaign_id: 'QUEST-ABANDON',
    expected_state_version: beforeCrashFinish.state_version,
    idempotency_key: 'crash-vote-b',
    events: crashResolution.events,
  })

  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)
  const recoveredAfterCrash = stateFrom(await request(baseUrl, '/api/rooms/QUEST-ABANDON', { cookie: adminCookie }))
  assert.equal(recoveredAfterCrash.agentInteraction, null)
  assert.equal(questFrom(recoveredAfterCrash, 'quest:first')?.status, 'abandoned')
  assert.equal(questFrom(recoveredAfterCrash, 'quest:second')?.status, 'abandoned')
  assert.equal(recoveredAfterCrash.scene.location, beforeLocation)
  assert.equal(recoveredAfterCrash.mechanics.world_time.elapsed_minutes, beforeTime)
  assert.deepEqual(Object.fromEntries(recoveredAfterCrash.players.map((player) => [player.id, { x: player.x, y: player.y }])), beforePositions)
})

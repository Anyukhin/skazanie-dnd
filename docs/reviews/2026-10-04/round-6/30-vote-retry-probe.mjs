import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error('backend exited before health check')
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('backend health timeout')
}

function cookie(headers) {
  return headers.get('set-cookie')?.split(';')[0] ?? ''
}

async function request(baseUrl, path, { cookie: session = '', body, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(session ? { cookie: session } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers }
}

function stateFor(code, interaction) {
  return {
    sessionCode: code,
    campaign: 'REC-02 controlled retry probe',
    activePlayerId: 'hero-a',
    partyMemberIds: ['hero-a', 'hero-b'],
    isNarrating: false,
    pendingCheck: null,
    agentInteraction: interaction,
    messages: [],
    players: [
      { id: 'hero-a', character: 'А', hp: 10, maxHp: 10, armor: 12, abilities: {}, proficiency: 2, inventory: [], online: true },
      { id: 'hero-b', character: 'Б', hp: 10, maxHp: 10, armor: 12, abilities: {}, proficiency: 2, inventory: [], online: true },
    ],
    scene: { title: 'Контрольный зал', location: 'Контрольный зал', mood: '', objective: 'Проверка', turn: 0, cells: [] },
  }
}

function openInteraction(id, type) {
  return {
    id,
    type,
    title: type === 'roll' ? 'Проверка отряда' : 'Куда идти?',
    description: 'Контрольное решение',
    options: type === 'roll'
      ? [{ id: 'success', label: 'Успех' }, { id: 'failure', label: 'Провал' }]
      : [{ id: 'north', label: 'На север' }, { id: 'south', label: 'На юг' }],
    votes: {},
    status: 'open',
    resolutionPrompt: '',
    createdAt: Date.now(),
    ...(type === 'roll' ? { difficulty: 12 } : {}),
    eligibleActorIds: ['hero-a', 'hero-b'],
    eligibleVoterIds: ['hero-a', 'hero-b'],
    voterByActorId: { 'hero-a': 'hero-a', 'hero-b': 'hero-b' },
    activeVoterIds: ['hero-a', 'hero-b'],
    abstainedVoterIds: [],
    requiredVotes: 2,
  }
}

function eventRecords(storage, campaignId) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name.endsWith('.json')) files.push(path)
    }
  }
  visit(storage)
  return files.flatMap((file) => {
    const commit = JSON.parse(readFileSync(file, 'utf8'))
    if (commit.campaign_id !== campaignId || !Array.isArray(commit.events)) return []
    return commit.events.map((event) => ({
      event_type: event.event_type,
      idempotency_key: event.idempotency_key,
      state_version_after: event.state_version_after,
      payload: event.payload,
    }))
  })
}

function stateReceipt(room) {
  const state = room.body?.state ?? {}
  return {
    state_version: state.state_version,
    votes: state.agentInteraction?.votes ?? null,
    resources: state.mechanics?.resources ?? {},
    world_time: state.mechanics?.world_time ?? {},
  }
}

async function main() {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-rec02-'))
  const backend = createServer()
  const backendPort = await listen(backend)
  backend.close()
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(backendPort),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: 'rec02-setup-token',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const backendUrl = `http://127.0.0.1:${backendPort}`
  let dropPath = null
  let dropped = false
  const proxy = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const headers = {}
    if (req.headers.cookie) headers.cookie = req.headers.cookie
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type']
    const upstream = await fetch(`${backendUrl}${req.url}`, {
      method: req.method,
      headers,
      body: body.length ? body : undefined,
    })
    const upstreamBody = Buffer.from(await upstream.arrayBuffer())
    if (!dropped && dropPath === req.url) {
      dropped = true
      // Ответ backend полностью получен до обрыва клиентского соединения.
      // Сохранение commit дополнительно проверяем чтением журнала событий.
      res.destroy()
      return
    }
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    res.end(upstreamBody)
  })
  const proxyPort = await listen(proxy)
  const proxyUrl = `http://127.0.0.1:${proxyPort}`
  const result = { runtime_pin: '88c620e6011ae607913efb224cb8f850b4ee5028', vote: null, roll: null }

  try {
    await waitForHealth(backendUrl, child)
    const setup = await request(backendUrl, '/api/auth/setup-admin', {
      body: { name: 'Admin', email: 'admin@rec02.test', password: 'admin-password-rec02', setupToken: 'rec02-setup-token' },
    })
    assert.equal(setup.status, 201)
    const adminCookie = cookie(setup.headers)
    const players = []
    for (const [heroId, label] of [['hero-a', 'A'], ['hero-b', 'B']]) {
      const registered = await request(backendUrl, '/api/auth/register', {
        body: { name: `Player ${label}`, email: `${heroId}@rec02.test`, password: 'player-password-rec02' },
      })
      assert.equal(registered.status, 201)
      const userList = await request(backendUrl, '/api/admin/users', { cookie: adminCookie })
      const user = userList.body.users.find((entry) => entry.email === `${heroId}@rec02.test`)
      assert.ok(user)
      const access = await request(backendUrl, `/api/admin/users/${user.id}`, {
        cookie: adminCookie,
        method: 'PATCH',
        body: { heroIds: [heroId] },
      })
      assert.equal(access.status, 200)
      players.push({ id: heroId, cookie: cookie(registered.headers) })
    }

    const voteCode = 'REC02-VOTE'
    const voteCreate = await request(backendUrl, '/api/campaigns', {
      cookie: adminCookie,
      body: { code: voteCode, state: stateFor(voteCode, openInteraction('vote-retry', 'vote')) },
    })
    assert.equal(voteCreate.status, 201, JSON.stringify(voteCreate.body))
    const votePath = `/api/campaigns/${voteCode}/party-decisions/vote-retry/votes`
    dropPath = votePath
    dropped = false
    const firstVote = await request(proxyUrl, votePath, {
      cookie: players[0].cookie,
      body: { actor_id: 'hero-a', option_id: 'north', idempotency_key: 'vote-k1' },
    }).catch((error) => ({ networkError: error.message }))
    assert.ok(firstVote.networkError, 'первый vote response должен быть потерян после upstream body')
    const voteAfterDrop = await request(backendUrl, `/api/rooms/${voteCode}`, { cookie: adminCookie })
    const voteEventsAfterDrop = eventRecords(storage, voteCode)
    assert.deepEqual(stateReceipt(voteAfterDrop).votes, { 'hero-a': 'north' })
    assert.equal(voteAfterDrop.body.state.state_version, 1)
    assert.equal(voteEventsAfterDrop.filter((event) => event.event_type === 'PartyVoteCast').length, 1)
    assert.equal(voteEventsAfterDrop.filter((event) => event.event_type === 'PartyDecisionResolved').length, 0)
    const sameKeyVote = await request(proxyUrl, votePath, {
      cookie: players[0].cookie,
      body: { actor_id: 'hero-a', option_id: 'north', idempotency_key: 'vote-k1' },
    })
    assert.equal(sameKeyVote.status, 200, 'тот же vote key должен вернуть replay')
    const voteAfterSameKey = await request(backendUrl, `/api/rooms/${voteCode}`, { cookie: adminCookie })
    const voteEventsAfterSameKey = eventRecords(storage, voteCode)
    assert.deepEqual(stateReceipt(voteAfterSameKey), stateReceipt(voteAfterDrop))
    assert.equal(voteEventsAfterSameKey.length, voteEventsAfterDrop.length)
    const retryVote = await request(proxyUrl, votePath, {
      cookie: players[0].cookie,
      body: { actor_id: 'hero-a', option_id: 'north', idempotency_key: 'vote-k2' },
    })
    assert.equal(retryVote.status, 200)
    const voteAfterNewKey = await request(backendUrl, `/api/rooms/${voteCode}`, { cookie: adminCookie })
    const voteEvents = eventRecords(storage, voteCode)
    assert.deepEqual(stateReceipt(voteAfterNewKey).votes, { 'hero-a': 'north' })
    assert.equal(voteAfterNewKey.body.state.state_version, 2)
    assert.deepEqual(stateReceipt(voteAfterNewKey).resources, stateReceipt(voteAfterDrop).resources)
    assert.deepEqual(stateReceipt(voteAfterNewKey).world_time, stateReceipt(voteAfterDrop).world_time)
    assert.equal(voteEvents.filter((event) => event.event_type === 'PartyVoteCast').length, 2)
    assert.equal(voteEvents.filter((event) => event.event_type === 'PartyDecisionResolved').length, 0)
    assert.deepEqual(voteEvents.map((event) => event.state_version_after), [1, 2])
    result.vote = {
      first_request: 'connection_dropped_after_upstream_body',
      first_backend_state_version: stateReceipt(voteAfterDrop).state_version,
      first_votes: stateReceipt(voteAfterDrop).votes,
      same_key_status: sameKeyVote.status,
      same_key_event_count: voteEventsAfterSameKey.length,
      retry_status: retryVote.status,
      retry_code: retryVote.body?.code ?? null,
      retry_state_version: retryVote.body?.state_version ?? null,
      retry_votes: stateReceipt(voteAfterNewKey).votes,
      resources_unchanged: JSON.stringify(stateReceipt(voteAfterNewKey).resources) === JSON.stringify(stateReceipt(voteAfterDrop).resources),
      world_time_unchanged: JSON.stringify(stateReceipt(voteAfterNewKey).world_time) === JSON.stringify(stateReceipt(voteAfterDrop).world_time),
      retry_event_types: retryVote.body?.mechanics?.map((event) => event.event_type) ?? [],
      event_log: voteEvents.map(({ event_type, idempotency_key, state_version_after }) => ({ event_type, idempotency_key, state_version_after })),
      vote_commit_count: voteEvents.filter((event) => event.event_type === 'PartyVoteCast').length,
      resolved_count: voteEvents.filter((event) => event.event_type === 'PartyDecisionResolved').length,
    }

    const rollCode = 'REC02-ROLL'
    const rollCreate = await request(backendUrl, '/api/campaigns', {
      cookie: adminCookie,
      body: { code: rollCode, state: stateFor(rollCode, openInteraction('roll-retry', 'roll')) },
    })
    assert.equal(rollCreate.status, 201, JSON.stringify(rollCreate.body))
    const rollPath = `/api/campaigns/${rollCode}/party-decisions/roll-retry/roll`
    dropPath = rollPath
    dropped = false
    const firstRoll = await request(proxyUrl, rollPath, {
      cookie: players[0].cookie,
      body: { actor_id: 'hero-a', idempotency_key: 'roll-k1' },
    }).catch((error) => ({ networkError: error.message }))
    assert.ok(firstRoll.networkError, 'первый roll response должен быть потерян после upstream body')
    const rollAfterDrop = await request(backendUrl, `/api/rooms/${rollCode}`, { cookie: adminCookie })
    const rollEventsAfterDrop = eventRecords(storage, rollCode)
    assert.equal(rollAfterDrop.body.state.state_version, 2)
    assert.equal(rollEventsAfterDrop.filter((event) => event.event_type === 'DieRolled').length, 1)
    assert.equal(rollEventsAfterDrop.filter((event) => event.event_type === 'PartyDecisionResolved').length, 1)
    const sameKeyRoll = await request(proxyUrl, rollPath, {
      cookie: players[0].cookie,
      body: { actor_id: 'hero-a', idempotency_key: 'roll-k1' },
    })
    assert.equal(sameKeyRoll.status, 200, 'тот же roll key должен вернуть replay')
    const rollAfterSameKey = await request(backendUrl, `/api/rooms/${rollCode}`, { cookie: adminCookie })
    const rollEventsAfterSameKey = eventRecords(storage, rollCode)
    assert.deepEqual(stateReceipt(rollAfterSameKey), stateReceipt(rollAfterDrop))
    assert.equal(rollEventsAfterSameKey.length, rollEventsAfterDrop.length)
    const retryRoll = await request(proxyUrl, rollPath, {
      cookie: players[0].cookie,
      body: { actor_id: 'hero-a', idempotency_key: 'roll-k2' },
    })
    const rollEvents = eventRecords(storage, rollCode)
    assert.equal(retryRoll.status, 409)
    assert.equal(retryRoll.body?.code, 'PARTY_DECISION_CLOSED')
    assert.equal(rollEvents.filter((event) => event.event_type === 'DieRolled').length, 1)
    assert.equal(rollEvents.filter((event) => event.event_type === 'PartyDecisionResolved').length, 1)
    assert.deepEqual(rollEvents.map((event) => event.state_version_after), [1, 2])
    result.roll = {
      first_request: 'connection_dropped_after_upstream_body',
      first_backend_state_version: stateReceipt(rollAfterDrop).state_version,
      same_key_status: sameKeyRoll.status,
      same_key_event_count: rollEventsAfterSameKey.length,
      retry_status: retryRoll.status,
      retry_code: retryRoll.body?.code ?? null,
      retry_state_version: retryRoll.body?.state_version ?? null,
      retry_roll: retryRoll.body?.roll ?? null,
      event_log: rollEvents.map(({ event_type, idempotency_key, state_version_after, payload }) => ({
        event_type, idempotency_key, state_version_after,
        ...(event_type === 'DieRolled' ? { roll_id: payload?.roll?.roll_id, value: payload?.roll?.value } : {}),
      })),
      die_rolled_count: rollEvents.filter((event) => event.event_type === 'DieRolled').length,
      resolved_count: rollEvents.filter((event) => event.event_type === 'PartyDecisionResolved').length,
    }
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await new Promise((resolve) => proxy.close(resolve))
    if (child.exitCode == null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})

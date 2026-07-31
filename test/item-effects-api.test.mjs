import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
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
      ADMIN_SETUP_TOKEN: 'item-effects-api-setup',
      GAME_ENGINE_MODE: 'enforce',
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
    if (child.exitCode != null) throw new Error(`Server exited\n${logs()}`)
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Server did not become healthy\n${logs()}`)
}

async function request(baseUrl, path, {
  method = 'GET',
  cookie = '',
  body,
  key = '',
} = {}) {
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

const sessionCookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

function fallenHero(id, x, y) {
  return {
    id,
    character: id,
    hp: 0,
    maxHp: 12,
    armor: 12,
    x,
    y,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    inventory: [],
  }
}

function initialState() {
  return {
    state_version: 0,
    sessionCode: 'ITEM-EFFECTS-API',
    campaign: 'Предметные эффекты',
    activePlayerId: 'medic',
    partyMemberIds: ['medic', 'ally-a', 'ally-b', 'ally-c'],
    players: [
      {
        id: 'medic',
        character: 'Лекарь',
        hp: 18,
        maxHp: 18,
        armor: 15,
        x: 0,
        y: 0,
        abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 16, cha: 10 },
        inventory: [
          {
            id: 'kit-idempotent',
            catalog_id: 'srd_5_2_1:healers-kit',
            name: 'Набор лекаря',
            type: 'gear',
            quantity: 1,
            charges: { current: 10, max: 10 },
          },
          {
            id: 'kit-last-charge',
            catalog_id: 'srd_5_2_1:healers-kit',
            name: 'Почти пустой набор лекаря',
            type: 'gear',
            quantity: 1,
            charges: { current: 1, max: 10 },
          },
        ],
      },
      fallenHero('ally-a', 1, 0),
      fallenHero('ally-b', 0, 1),
      fallenHero('ally-c', 1, 1),
    ],
    scene: {
      title: 'Лазарет',
      location: 'Лазарет',
      turn: 1,
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'floor', revealed: true },
        { x: 0, y: 1, type: 'floor', revealed: true },
        { x: 1, y: 1, type: 'floor', revealed: true },
      ],
    },
    mechanics: {
      positions: {
        medic: { x: 0, y: 0 },
        'ally-a': { x: 1, y: 0 },
        'ally-b': { x: 0, y: 1 },
        'ally-c': { x: 1, y: 1 },
      },
      conditions: {
        'ally-a': [{ id: 'unconscious' }],
        'ally-b': [{ id: 'unconscious' }],
        'ally-c': [{ id: 'unconscious' }],
      },
      death: {
        saving_throws: {
          'ally-a': { successes: 0, failures: 0, stable: false },
          'ally-b': { successes: 0, failures: 0, stable: false },
          'ally-c': { successes: 0, failures: 0, stable: false },
        },
        heroes: {},
        campaign_status: 'active',
      },
      combat: { active: false },
    },
  }
}

function itemCommand(key, itemId, targetId, expectedStateVersion) {
  const command = {
    command_type: 'UseItem',
    actor_id: 'medic',
    item_id: itemId,
    target_id: targetId,
    ...(expectedStateVersion == null ? {} : { expected_state_version: expectedStateVersion }),
  }
  return {
    key,
    body: {
      idempotency_key: key,
      command,
    },
  }
}

test('HTTP item commands enforce ACL, semantic idempotency, stale writes and a single last charge', { timeout: 60_000 }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-item-effects-api-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })

  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: {
      name: 'GM',
      email: 'gm@item-effects.test',
      password: 'secure-admin-password',
      setupToken: 'item-effects-api-setup',
    },
  })
  assert.equal(admin.status, 201, `${admin.text}\n${logs}`)
  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Owner', email: 'owner@item-effects.test', password: 'secure-owner-password' },
  })
  const foreign = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Foreign', email: 'foreign@item-effects.test', password: 'secure-foreign-password' },
  })
  assert.equal(owner.status, 201, `${owner.text}\n${logs}`)
  assert.equal(foreign.status, 201, `${foreign.text}\n${logs}`)
  const adminCookie = sessionCookie(admin)
  const ownerCookie = sessionCookie(owner)
  const foreignCookie = sessionCookie(foreign)

  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const ownerUser = users.body.users.find((candidate) => candidate.email === 'owner@item-effects.test')
  const ownership = await request(baseUrl, `/api/admin/users/${ownerUser.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { heroIds: ['medic'] },
  })
  assert.equal(ownership.status, 200, `${ownership.text}\n${logs}`)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      code: 'ITEM-EFFECTS-API',
      name: 'Предметные эффекты',
      state: initialState(),
    },
  })
  assert.equal(created.status, 201, `${created.text}\n${logs}`)

  const firstCommand = itemCommand('item-same-command', 'kit-idempotent', 'ally-a')
  const forbidden = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: foreignCookie,
    key: 'item-forbidden',
    body: { ...firstCommand.body, idempotency_key: 'item-forbidden' },
  })
  assert.equal(forbidden.status, 403, `${forbidden.text}\n${logs}`)

  const first = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...firstCommand,
  })
  assert.equal(first.status, 200, `${first.text}\n${logs}`)
  assert.deepEqual(first.body.mechanics.map((event) => event.event_type), [
    'ItemUsed',
    'HeroStabilized',
    'ItemChargesSpent',
  ])
  const projectedKit = first.body.authoritative_state.players[0].inventory
    .find((item) => item.id === 'kit-idempotent')
  assert.deepEqual(projectedKit.capabilities.charges, { current: 9, max: 10 })

  const duplicate = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...firstCommand,
  })
  assert.equal(duplicate.status, 200, `${duplicate.text}\n${logs}`)
  assert.equal(duplicate.body.idempotent_replay, true)
  assert.deepEqual(
    duplicate.body.authoritative_state.players[0].inventory
      .find((item) => item.id === 'kit-idempotent').capabilities.charges,
    { current: 9, max: 10 },
  )

  const collisionCommand = itemCommand('item-same-command', 'kit-idempotent', 'ally-b')
  const collision = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...collisionCommand,
  })
  assert.equal(collision.status, 409, `${collision.text}\n${logs}`)
  assert.equal(collision.body.code, 'IDEMPOTENCY_CONFLICT')

  const staleCommand = itemCommand('item-stale', 'kit-last-charge', 'ally-b', 0)
  const stale = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...staleCommand,
  })
  assert.equal(stale.status, 409, `${stale.text}\n${logs}`)
  assert.equal(stale.body.code, 'STATE_VERSION_CONFLICT')

  const roomBeforeRace = await request(baseUrl, '/api/rooms/ITEM-EFFECTS-API', { cookie: adminCookie })
  assert.equal(roomBeforeRace.status, 200, `${roomBeforeRace.text}\n${logs}`)
  const version = roomBeforeRace.body.state.state_version
  const raceCommands = [
    itemCommand('item-last-charge-a', 'kit-last-charge', 'ally-b', version),
    itemCommand('item-last-charge-b', 'kit-last-charge', 'ally-c', version),
  ]
  const race = await Promise.all(raceCommands.map((entry) => request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...entry,
  })))
  assert.equal(race.filter((result) => result.status === 200).length, 1, race.map((result) => result.text).join('\n'))
  assert.equal(race.filter((result) => result.status === 409).length, 1, race.map((result) => result.text).join('\n'))

  const roomAfterRace = await request(baseUrl, '/api/rooms/ITEM-EFFECTS-API', { cookie: adminCookie })
  assert.equal(roomAfterRace.status, 200, `${roomAfterRace.text}\n${logs}`)
  const finalState = roomAfterRace.body.state
  const finalKit = finalState.players[0].inventory.find((item) => item.id === 'kit-last-charge')
  assert.deepEqual(finalKit.charges, { current: 0, max: 10 })
  const stableTargets = ['ally-b', 'ally-c']
    .filter((id) => finalState.mechanics.death.saving_throws[id].stable === true)
  assert.equal(stableTargets.length, 1)

  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const durableRoom = await request(baseUrl, '/api/rooms/ITEM-EFFECTS-API', { cookie: adminCookie })
  assert.equal(durableRoom.status, 200, `${durableRoom.text}\n${logs}`)
  const durableState = durableRoom.body.state
  assert.deepEqual(
    durableState.players[0].inventory.find((item) => item.id === 'kit-last-charge').charges,
    { current: 0, max: 10 },
  )
  assert.equal(
    ['ally-b', 'ally-c'].filter((id) => durableState.mechanics.death.saving_throws[id].stable === true).length,
    1,
  )

  const durableReplay = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...firstCommand,
  })
  assert.equal(durableReplay.status, 200, `${durableReplay.text}\n${logs}`)
  assert.equal(durableReplay.body.idempotent_replay, true)
  assert.deepEqual(
    durableReplay.body.authoritative_state.players[0].inventory
      .find((item) => item.id === 'kit-idempotent').capabilities.charges,
    { current: 9, max: 10 },
  )
})

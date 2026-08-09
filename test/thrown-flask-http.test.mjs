import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileEventStore } from '../server/event-store.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { MapStore } from '../server/map-store.mjs'
import {
  GAME_STATE_PROJECTOR_VERSION,
  applyGameEvent,
  normalizeCampaignState,
} from '../server/rules-engine.mjs'

const ACID = 'srd_5_2_1:acid'

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
      ADMIN_SETUP_TOKEN: 'thrown-flask-http-setup',
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

function sessionCookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

function initialState() {
  return {
    state_version: 0,
    sessionCode: 'THROWN-FLASK-HTTP',
    campaign: 'Метание кислоты',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      character: 'Алхимик',
      characterClass: 'fighter',
      level: 12,
      proficiency: 4,
      hp: 30,
      maxHp: 30,
      armor: 15,
      speed: 30,
      x: 0,
      y: 0,
      abilities: { str: 12, dex: 20, con: 14, int: 10, wis: 10, cha: 10 },
      inventory: [materializeCatalogItem(ACID, { id: 'acid', quantity: 1 })],
    }],
    enemies: [{
      id: 'foe',
      name: 'Тренировочная цель',
      hp: 30,
      maxHp: 30,
      armor: 18,
      speed: 30,
      alive: true,
      creature_type: 'beast',
      abilities: { str: 12, dex: 1, con: 12, int: 6, wis: 10, cha: 6 },
      x: 2,
      y: 0,
    }],
    scene: {
      title: 'Полигон',
      location: 'Полигон',
      turn: 1,
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'floor', revealed: true },
        { x: 2, y: 0, type: 'floor', revealed: true },
      ],
    },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, foe: { x: 2, y: 0 } },
      conditions: {},
      death: { saving_throws: {}, heroes: {}, campaign_status: 'active' },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'foe', total: 5 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 1 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 1 },
        },
      },
    },
  }
}

function flaskCommand(key, targetId = 'foe') {
  return {
    idempotency_key: key,
    command: {
      command_type: 'UseItem',
      actor_id: 'hero',
      item_id: 'acid',
      target_id: targetId,
    },
  }
}

test('HTTP UseItem флакона кислоты сохраняет SRD-эффект, права, идемпотентность и FileEventStore replay', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-thrown-flask-http-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'GM', email: 'gm@thrown-flask.test', password: 'secure-admin-password', setupToken: 'thrown-flask-http-setup' },
  })
  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Owner', email: 'owner@thrown-flask.test', password: 'secure-owner-password' },
  })
  const foreign = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Foreign', email: 'foreign@thrown-flask.test', password: 'secure-foreign-password' },
  })
  assert.equal(admin.status, 201, `${admin.text}\n${logs}`)
  assert.equal(owner.status, 201, `${owner.text}\n${logs}`)
  assert.equal(foreign.status, 201, `${foreign.text}\n${logs}`)
  const adminCookie = sessionCookie(admin)
  const ownerCookie = sessionCookie(owner)
  const foreignCookie = sessionCookie(foreign)

  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const ownerUser = users.body.users.find((candidate) => candidate.email === 'owner@thrown-flask.test')
  const ownership = await request(baseUrl, `/api/admin/users/${ownerUser.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { heroIds: ['hero'] },
  })
  assert.equal(ownership.status, 200, `${ownership.text}\n${logs}`)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: adminCookie,
    body: { code: 'THROWN-FLASK-HTTP', name: 'Метание кислоты', state: initialState() },
  })
  assert.equal(created.status, 201, `${created.text}\n${logs}`)

  const unauthorized = await request(baseUrl, '/api/campaigns/THROWN-FLASK-HTTP/commands', {
    method: 'POST',
    cookie: foreignCookie,
    key: 'acid-forbidden',
    body: flaskCommand('acid-forbidden'),
  })
  assert.equal(unauthorized.status, 403, `${unauthorized.text}\n${logs}`)

  const key = 'acid-throw-once'
  const command = flaskCommand(key)
  const first = await request(baseUrl, '/api/campaigns/THROWN-FLASK-HTTP/commands', {
    method: 'POST', cookie: ownerCookie, key, body: command,
  })
  assert.equal(first.status, 200, `${first.text}\n${logs}`)
  assert.ok(first.body.mechanics.some((event) => event.event_type === 'ItemUsed'))
  const save = first.body.mechanics.find((event) => event.event_type === 'SavingThrowResolved')
  const damage = first.body.mechanics.find((event) => event.event_type === 'DamageApplied')
  assert.ok(save)
  assert.equal(save.payload.ability, 'dex')
  assert.equal(save.payload.source, 'item-thrown')
  assert.equal(save.payload.saved, false)
  assert.ok(damage)
  assert.equal(damage.payload.damage_type, 'acid')
  assert.ok(damage.payload.applied_amount > 0)
  const firstState = first.body.authoritative_state
  const firstEnemyStatus = firstState.enemies.find((enemy) => enemy.id === 'foe').healthStatus
  assert.equal(firstEnemyStatus, 'wounded')
  assert.equal(firstState.players.find((player) => player.id === 'hero').inventory.some((item) => item.id === 'acid'), false)

  const duplicate = await request(baseUrl, '/api/campaigns/THROWN-FLASK-HTTP/commands', {
    method: 'POST', cookie: ownerCookie, key, body: command,
  })
  assert.equal(duplicate.status, 200, `${duplicate.text}\n${logs}`)
  assert.equal(duplicate.body.idempotent_replay, true)
  assert.equal(duplicate.body.authoritative_state.enemies.find((enemy) => enemy.id === 'foe').healthStatus, firstEnemyStatus)
  assert.equal(duplicate.body.authoritative_state.players.find((player) => player.id === 'hero').inventory.some((item) => item.id === 'acid'), false)

  const conflict = await request(baseUrl, '/api/campaigns/THROWN-FLASK-HTTP/commands', {
    method: 'POST', cookie: ownerCookie, key, body: flaskCommand(key, 'hero'),
  })
  assert.equal(conflict.status, 409, `${conflict.text}\n${logs}`)
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT')

  await stopServer(child)
  child = null

  const eventStore = new FileEventStore({
    rootDir: join(storage, 'engine'),
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
    mapStore: new MapStore({ rootDir: join(storage, 'engine') }),
  })
  const durable = await eventStore.load('THROWN-FLASK-HTTP')
  const durableEnemyHp = durable.state.enemies.find((enemy) => enemy.id === 'foe').hp
  assert.ok(durableEnemyHp < 30)
  assert.equal(durable.state.players.find((player) => player.id === 'hero').inventory.some((item) => item.id === 'acid'), false)
  const storedEvents = await eventStore.getEvents('THROWN-FLASK-HTTP')
  assert.equal(storedEvents.filter((event) => event.event_type === 'ItemUsed').length, 1)
  assert.equal(storedEvents.filter((event) => event.event_type === 'DamageApplied').length, 1)

  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const afterRestart = await request(baseUrl, '/api/campaigns/THROWN-FLASK-HTTP/commands', {
    method: 'POST', cookie: ownerCookie, key, body: command,
  })
  assert.equal(afterRestart.status, 200, `${afterRestart.text}\n${logs}`)
  assert.equal(afterRestart.body.idempotent_replay, true)
  assert.equal(afterRestart.body.authoritative_state.enemies.find((enemy) => enemy.id === 'foe').healthStatus, firstEnemyStatus)
  assert.equal(afterRestart.body.authoritative_state.players.find((player) => player.id === 'hero').inventory.some((item) => item.id === 'acid'), false)
})

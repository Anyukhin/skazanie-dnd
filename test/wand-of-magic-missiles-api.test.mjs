import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { MapStore } from '../server/map-store.mjs'
import {
  GAME_STATE_PROJECTOR_VERSION,
  applyGameEvent,
  normalizeCampaignState,
  resolveCommand,
} from '../server/rules-engine.mjs'

const WAND_ID = 'srd_5_2_1:wand-of-magic-missiles'

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
      ADMIN_SETUP_TOKEN: 'wand-api-setup',
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

function campaign(code, charges) {
  return {
    state_version: 0,
    sessionCode: code,
    campaign: 'Проверка жезла',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      character: 'Воин',
      characterClass: 'fighter',
      level: 3,
      hp: 30,
      maxHp: 30,
      armor: 16,
      proficiency: 2,
      x: 0,
      y: 0,
      abilities: { str: 16, dex: 12, con: 14, int: 8, wis: 10, cha: 10 },
      inventory: [materializeCatalogItem(WAND_ID, {
        id: 'wand',
        quantity: 1,
        equipped: true,
        charges: { current: charges, max: 7 },
      })],
    }],
    enemies: [{
      id: 'foe',
      name: 'Огр',
      hp: 50,
      maxHp: 50,
      armor: 12,
      speed: 30,
      x: 2,
      y: 0,
      alive: true,
      abilities: { str: 18, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
    }],
    scene: {
      title: 'Арена',
      location: 'Арена',
      turn: 1,
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'floor', revealed: true },
        { x: 2, y: 0, type: 'floor', revealed: true },
      ],
    },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, foe: { x: 2, y: 0 } },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'hero', total: 18 }, { actor_id: 'foe', total: 8 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  }
}

function commandBody(key, chargesToSpend, extra = {}) {
  return {
    idempotency_key: key,
    command: {
      command_type: 'UseItem',
      actor_id: 'hero',
      item_id: 'wand',
      target_id: 'foe',
      charges_to_spend: chargesToSpend,
      ...extra,
    },
  }
}

function itemFingerprint(chargesToSpend) {
  return createHash('sha256').update(JSON.stringify({
    type: 'UseItem',
    actor_id: 'hero',
    item_id: 'wand',
    target_id: 'foe',
    charges_to_spend: chargesToSpend,
    to: null,
    use_mode: '',
    weapon_id: '',
  })).digest('hex')
}

test('HTTP жезла защищает поля и charges_to_spend idempotency, включая retry после уничтожения', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-wand-api-'))
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
      email: 'gm@wand-api.test',
      password: 'secure-admin-password',
      setupToken: 'wand-api-setup',
    },
  })
  assert.equal(admin.status, 201, `${admin.text}\n${logs}`)
  const cookie = admin.response.headers.get('set-cookie')?.split(';')[0]

  for (const [code, charges] of [['WAND-API', 7], ['WAND-DESTROY', 1]]) {
    const created = await request(baseUrl, '/api/campaigns', {
      method: 'POST',
      cookie,
      body: { code, name: 'Проверка жезла', state: campaign(code, charges) },
    })
    assert.equal(created.status, 201, `${created.text}\n${logs}`)
  }

  for (const forged of [
    { spell_id: 'fireball' },
    { formula: '99d99' },
    { projectile_count: 99 },
  ]) {
    const rejected = await request(baseUrl, '/api/campaigns/WAND-API/commands', {
      method: 'POST',
      cookie,
      key: `forged-${Object.keys(forged)[0]}`,
      body: commandBody(`forged-${Object.keys(forged)[0]}`, 1, forged),
    })
    assert.equal(rejected.status, 400, `${rejected.text}\n${logs}`)
    assert.equal(rejected.body.code, 'ITEM_COMMAND_UNKNOWN_FIELD')
  }

  const key = 'wand-spend-one'
  const first = await request(baseUrl, '/api/campaigns/WAND-API/commands', {
    method: 'POST',
    cookie,
    key,
    body: commandBody(key, 1),
  })
  assert.equal(first.status, 200, `${first.text}\n${logs}`)
  assert.ok(first.body.mechanics.some((event) => event.event_type === 'SpellCast'
    && event.payload.source?.kind === 'magic-item'))
  assert.equal(first.body.mechanics.some((event) => event.event_type === 'ResourceSpent'), false)
  assert.deepEqual(
    first.body.authoritative_state.players[0].inventory.find((item) => item.id === 'wand').charges,
    { current: 6, max: 7 },
  )

  const duplicate = await request(baseUrl, '/api/campaigns/WAND-API/commands', {
    method: 'POST',
    cookie,
    key,
    body: commandBody(key, 1),
  })
  assert.equal(duplicate.status, 200, `${duplicate.text}\n${logs}`)
  assert.equal(duplicate.body.idempotent_replay, true)

  const conflictingSpend = await request(baseUrl, '/api/campaigns/WAND-API/commands', {
    method: 'POST',
    cookie,
    key,
    body: commandBody(key, 2),
  })
  assert.equal(conflictingSpend.status, 409, `${conflictingSpend.text}\n${logs}`)
  assert.equal(conflictingSpend.body.code, 'IDEMPOTENCY_CONFLICT')

  await stopServer(child)
  child = null

  const eventStore = new FileEventStore({
    rootDir: join(storage, 'engine'),
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
    mapStore: new MapStore({ rootDir: join(storage, 'engine') }),
  })
  const before = await eventStore.load('WAND-DESTROY')
  const destroyKey = 'wand-destroyed-retry'
  const fingerprint = itemFingerprint(1)
  const resolved = resolveCommand({
    command_type: 'UseItem',
    command_id: destroyKey,
    campaign_id: 'WAND-DESTROY',
    actor_id: 'hero',
    item_id: 'wand',
    target_id: 'foe',
    charges_to_spend: 1,
    request_fingerprint: fingerprint,
    server_authoritative: true,
  }, before.state, {
    diceService: new DiceService({
      rng: new SequenceDiceRng([2, 1]),
      idFactory: (() => {
        let id = 0
        return () => `destroy-roll-${++id}`
      })(),
      now: () => '2026-07-31T12:00:00.000Z',
    }),
    context: { isAdmin: true, serverAuthoritativeCombat: true },
  })
  const committed = await eventStore.commit({
    campaign_id: 'WAND-DESTROY',
    expected_state_version: before.state_version,
    idempotency_key: destroyKey,
    command_id: destroyKey,
    events: resolved.events,
  })
  assert.equal(committed.state.players[0].inventory.some((item) => item.id === 'wand'), false)
  assert.ok(committed.events.some((event) => event.event_type === 'ItemDestroyed'))

  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const replayAfterDestruction = await request(baseUrl, '/api/campaigns/WAND-DESTROY/commands', {
    method: 'POST',
    cookie,
    key: destroyKey,
    body: commandBody(destroyKey, 1),
  })
  assert.equal(replayAfterDestruction.status, 200, `${replayAfterDestruction.text}\n${logs}`)
  assert.equal(replayAfterDestruction.body.idempotent_replay, true)
  assert.equal(replayAfterDestruction.body.authoritative_state.players[0].inventory.some((item) => item.id === 'wand'), false)

  const conflictAfterDestruction = await request(baseUrl, '/api/campaigns/WAND-DESTROY/commands', {
    method: 'POST',
    cookie,
    key: destroyKey,
    body: commandBody(destroyKey, 2),
  })
  assert.equal(conflictAfterDestruction.status, 409, `${conflictAfterDestruction.text}\n${logs}`)
  assert.equal(conflictAfterDestruction.body.code, 'IDEMPOTENCY_CONFLICT')
})

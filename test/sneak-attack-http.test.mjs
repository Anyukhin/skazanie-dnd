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
      ADMIN_SETUP_TOKEN: 'sneak-attack-http-setup',
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

function initialState(code) {
  return {
    state_version: 0,
    sessionCode: code,
    campaign: 'Проверка Скрытой атаки',
    activePlayerId: 'rogue',
    partyMemberIds: ['rogue', 'ally'],
    players: [
      {
        id: 'rogue',
        character: 'Тень',
        characterClass: 'rogue',
        level: 5,
        proficiency: 3,
        hp: 30,
        maxHp: 30,
        armor: 15,
        speed: 30,
        x: 1,
        y: 1,
        abilities: { str: 10, dex: 16, con: 12, int: 12, wis: 12, cha: 10 },
        inventory: [materializeCatalogItem('srd_5_2_1:rapier', { id: 'rapier', quantity: 1, equipped: true })],
      },
      {
        id: 'ally',
        character: 'Союзник',
        characterClass: 'fighter',
        level: 5,
        proficiency: 3,
        hp: 30,
        maxHp: 30,
        armor: 16,
        speed: 30,
        x: 2,
        y: 2,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
        inventory: [],
      },
    ],
    enemies: [{
      id: 'enemy',
      name: 'Цель',
      hp: 100,
      maxHp: 100,
      armor: 1,
      speed: 30,
      alive: true,
      creature_type: 'beast',
      x: 2,
      y: 1,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    }],
    scene: {
      title: 'Полигон',
      location: 'Полигон',
      turn: 1,
      cells: Array.from({ length: 16 }, (_, index) => ({
        x: index % 4,
        y: Math.floor(index / 4),
        type: 'floor',
        revealed: true,
      })),
    },
    mechanics: {
      positions: { rogue: { x: 1, y: 1 }, ally: { x: 2, y: 2 }, enemy: { x: 2, y: 1 } },
      conditions: {},
      death: { saving_throws: {}, heroes: {}, campaign_status: 'active' },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'rogue', total: 20 }, { actor_id: 'enemy', total: 10 }],
        action_economy: {
          rogue: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 1 },
          enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 1 },
        },
      },
    },
  }
}

function attackCommand(key, sneakAttack = true) {
  return {
    idempotency_key: key,
    command: {
      command_type: 'MakeAttack',
      actor_id: 'rogue',
      target_id: 'enemy',
      item_id: 'rapier',
      attack_ability: 'dex',
      sneak_attack: sneakAttack,
    },
  }
}

test('HTTP MakeAttack игрока применяет Скрытую атаку плута, защищает ключ и переживает рестарт', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-sneak-attack-http-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'GM', email: 'gm@sneak-attack.test', password: 'secure-admin-password', setupToken: 'sneak-attack-http-setup' },
  })
  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Owner', email: 'owner@sneak-attack.test', password: 'secure-owner-password' },
  })
  const foreign = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Foreign', email: 'foreign@sneak-attack.test', password: 'secure-foreign-password' },
  })
  assert.equal(admin.status, 201, `${admin.text}\n${logs}`)
  assert.equal(owner.status, 201, `${owner.text}\n${logs}`)
  assert.equal(foreign.status, 201, `${foreign.text}\n${logs}`)
  const adminCookie = sessionCookie(admin)
  const ownerCookie = sessionCookie(owner)
  const foreignCookie = sessionCookie(foreign)

  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const ownerUser = users.body.users.find((candidate) => candidate.email === 'owner@sneak-attack.test')
  const ownership = await request(baseUrl, `/api/admin/users/${ownerUser.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['rogue'] },
  })
  assert.equal(ownership.status, 200, `${ownership.text}\n${logs}`)

  let selected = null
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const campaignId = `SNEAK-HTTP-${attempt}`
    const created = await request(baseUrl, '/api/campaigns', {
      method: 'POST', cookie: adminCookie,
      body: { code: campaignId, name: 'Проверка Скрытой атаки', state: initialState(campaignId) },
    })
    assert.equal(created.status, 201, `${created.text}\n${logs}`)

    const forbidden = await request(baseUrl, `/api/campaigns/${campaignId}/commands`, {
      method: 'POST', cookie: foreignCookie, key: `sneak-forbidden-${attempt}`, body: attackCommand(`sneak-forbidden-${attempt}`),
    })
    assert.equal(forbidden.status, 403, `${forbidden.text}\n${logs}`)

    const key = `sneak-attack-${attempt}`
    const command = attackCommand(key)
    const result = await request(baseUrl, `/api/campaigns/${campaignId}/commands`, {
      method: 'POST', cookie: ownerCookie, key, body: command,
    })
    assert.equal(result.status, 200, `${result.text}\n${logs}`)
    if (result.body.mechanics.some((event) => event.event_type === 'SneakAttackApplied')) {
      selected = { campaignId, key, command, result }
      break
    }
  }
  assert.ok(selected, 'пять атак по КД 1 не должны все выпасть натуральной единицей')

  const { campaignId, key, command, result: first } = selected
  const attack = first.body.mechanics.find((event) => event.event_type === 'AttackResolved')
  const sneak = first.body.mechanics.find((event) => event.event_type === 'SneakAttackApplied')
  assert.equal(attack.payload.hit, true)
  assert.equal(attack.payload.sneak_attack_eligible_by, 'ally')
  assert.equal(attack.payload.sneak_attack_supporter_id, 'ally')
  assert.equal(sneak.payload.expression, '3d6')
  assert.equal(sneak.payload.supporter_id, 'ally')

  const duplicate = await request(baseUrl, `/api/campaigns/${campaignId}/commands`, {
    method: 'POST', cookie: ownerCookie, key, body: command,
  })
  assert.equal(duplicate.status, 200, `${duplicate.text}\n${logs}`)
  assert.equal(duplicate.body.idempotent_replay, true)

  const conflict = await request(baseUrl, `/api/campaigns/${campaignId}/commands`, {
    method: 'POST', cookie: ownerCookie, key, body: attackCommand(key, false),
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
  const durable = await eventStore.load(campaignId)
  const enemyHp = durable.state.enemies.find((enemy) => enemy.id === 'enemy').hp
  assert.ok(enemyHp < 100)
  assert.equal(durable.state.mechanics.combat.action_economy.rogue.sneak_attack_turn_key, 'combat:1:rogue')
  const storedEvents = await eventStore.getEvents(campaignId)
  assert.equal(storedEvents.filter((event) => event.event_type === 'AttackResolved').length, 1)
  assert.equal(storedEvents.filter((event) => event.event_type === 'SneakAttackApplied').length, 1)

  const restartPort = await freePort()
  baseUrl = `http://127.0.0.1:${restartPort}`
  child = startServer(restartPort, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const afterRestart = await request(baseUrl, `/api/campaigns/${campaignId}/commands`, {
    method: 'POST', cookie: ownerCookie, key, body: command,
  })
  assert.equal(afterRestart.status, 200, `${afterRestart.text}\n${logs}`)
  assert.equal(afterRestart.body.idempotent_replay, true)
})

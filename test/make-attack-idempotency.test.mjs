import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileEventStore } from '../server/event-store.mjs'
import { MapStore } from '../server/map-store.mjs'
import {
  GAME_STATE_PROJECTOR_VERSION,
  applyGameEvent,
  normalizeCampaignState,
} from '../server/rules-engine.mjs'

const SETUP_TOKEN = 'make-attack-idempotency-setup'

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
      ADMIN_SETUP_TOKEN: SETUP_TOKEN,
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

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text }
}

function sessionCookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

function initialState(code, { enemyHp = 100, activeActor = 'hero', withSummon = false } = {}) {
  return {
    state_version: 0,
    sessionCode: code,
    campaign: 'MakeAttack idempotency',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      character: 'Tester',
      characterClass: 'fighter',
      level: 5,
      proficiency: 3,
      hp: 30,
      maxHp: 30,
      armor: 16,
      speed: 30,
      x: 1,
      y: 1,
      abilities: { str: 20, dex: 14, con: 14, int: 10, wis: 10, cha: 10 },
      inventory: [],
      attackBonus: 100,
      damageDice: 6,
      damageBonus: 100,
      damageType: 'slashing',
      attackRange: 5,
    }],
    actors: withSummon ? [{
      id: 'summon',
      name: 'Spirit',
      kind: 'summon',
      faction: 'party',
      ownerId: 'hero',
      controllerId: 'hero',
      hp: 20,
      maxHp: 20,
      armor: 13,
      speed: 30,
      alive: true,
      x: 1,
      y: 2,
      attackBonus: 8,
      damageDice: 6,
      damageBonus: 4,
      damageType: 'force',
      attackRange: 5,
      abilities: { str: 16, dex: 14, con: 14, int: 8, wis: 12, cha: 8 },
    }] : [],
    enemies: [{
      id: 'enemy',
      name: 'Target',
      hp: enemyHp,
      maxHp: enemyHp,
      armor: 1,
      speed: 30,
      alive: true,
      attackBonus: 7,
      damageDice: 4,
      damageBonus: 3,
      damageType: 'piercing',
      attackRange: 5,
      x: 2,
      y: 1,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    }],
    scene: {
      title: 'Arena',
      location: 'Arena',
      turn: 1,
      cells: Array.from({ length: 16 }, (_, index) => ({
        x: index % 4,
        y: Math.floor(index / 4),
        type: 'floor',
        revealed: true,
      })),
    },
    mechanics: {
      positions: {
        hero: { x: 1, y: 1 },
        enemy: { x: 2, y: 1 },
        ...(withSummon ? { summon: { x: 1, y: 2 } } : {}),
      },
      conditions: {},
      death: { saving_throws: {}, heroes: {}, campaign_status: 'active' },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: activeActor === 'enemy'
          ? [{ actor_id: 'enemy', total: 20 }, { actor_id: 'hero', total: 10 }]
          : activeActor === 'summon'
            ? [{ actor_id: 'summon', total: 20 }, { actor_id: 'hero', total: 15 }, { actor_id: 'enemy', total: 10 }]
            : [{ actor_id: 'hero', total: 20 }, { actor_id: 'enemy', total: 10 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 2 },
          enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 1 },
          ...(withSummon ? { summon: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 1 } } : {}),
        },
      },
    },
  }
}

function attack(overrides = {}) {
  return {
    command_type: 'MakeAttack',
    actor_id: 'hero',
    target_id: 'enemy',
    ...overrides,
  }
}

async function sendCommands(baseUrl, cookie, campaignId, key, commands) {
  return request(baseUrl, `/api/campaigns/${campaignId}/commands`, {
    method: 'POST',
    cookie,
    body: {
      idempotency_key: key,
      ...(commands.length === 1 ? { command: commands[0] } : { commands }),
    },
  })
}

async function createCampaign(baseUrl, adminCookie, code, options) {
  const result = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: adminCookie,
    body: { code, name: code, state: initialState(code, options) },
  })
  assert.equal(result.status, 201, result.text)
}

test('семантическая идемпотентность MakeAttack сохраняет смертельные повторы, кратность массива и нормализацию администратора', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-make-attack-idempotency-'))
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
    body: { name: 'GM', email: 'gm@attack-idempotency.test', password: 'secure-admin-password', setupToken: SETUP_TOKEN },
  })
  const player = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Player', email: 'player@attack-idempotency.test', password: 'secure-player-password' },
  })
  const foreign = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Foreign', email: 'foreign@attack-idempotency.test', password: 'secure-foreign-password' },
  })
  assert.equal(admin.status, 201, `${admin.text}\n${logs}`)
  assert.equal(player.status, 201, `${player.text}\n${logs}`)
  assert.equal(foreign.status, 201, `${foreign.text}\n${logs}`)
  const adminCookie = sessionCookie(admin)
  const playerCookie = sessionCookie(player)
  const foreignCookie = sessionCookie(foreign)

  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const playerUser = users.body.users.find((candidate) => candidate.email === 'player@attack-idempotency.test')
  const assigned = await request(baseUrl, `/api/admin/users/${playerUser.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero'] },
  })
  assert.equal(assigned.status, 200, `${assigned.text}\n${logs}`)

  let lethal = null
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const campaignId = `ATTACK-LETHAL-${attempt}`
    await createCampaign(baseUrl, adminCookie, campaignId, { enemyHp: 1 })
    const key = `lethal-${attempt}`
    const command = attack()
    const first = await sendCommands(baseUrl, playerCookie, campaignId, key, [command])
    assert.equal(first.status, 200, `${first.text}\n${logs}`)
    const damage = first.body.mechanics.find((event) => event.event_type === 'DamageApplied')
    if (damage) {
      lethal = { campaignId, key, command, first }
      break
    }
  }
  assert.ok(lethal, 'five attacks with +100 must not all be natural ones')

  const lethalRetry = await sendCommands(baseUrl, playerCookie, lethal.campaignId, lethal.key, [lethal.command])
  assert.equal(lethalRetry.status, 200, `${lethalRetry.text}\n${logs}`)
  assert.equal(lethalRetry.body.idempotent_replay, true)
  assert.equal(lethalRetry.body.authoritative_state.state_version, lethal.first.body.authoritative_state.state_version)

  const multiplicityCampaign = 'ATTACK-MULTIPLICITY'
  await createCampaign(baseUrl, adminCookie, multiplicityCampaign, { enemyHp: 1_000 })
  const multiplicityKey = 'one-versus-two'
  const oneAttack = await sendCommands(baseUrl, playerCookie, multiplicityCampaign, multiplicityKey, [attack()])
  assert.equal(oneAttack.status, 200, `${oneAttack.text}\n${logs}`)
  const beforeMultiplicityCollision = await request(baseUrl, `/api/rooms/${multiplicityCampaign}`, { cookie: adminCookie })
  const twoAttacks = await sendCommands(baseUrl, playerCookie, multiplicityCampaign, multiplicityKey, [attack(), attack()])
  assert.equal(twoAttacks.status, 409, `${twoAttacks.text}\n${logs}`)
  assert.equal(twoAttacks.body.code, 'IDEMPOTENCY_CONFLICT')
  const afterMultiplicityCollision = await request(baseUrl, `/api/rooms/${multiplicityCampaign}`, { cookie: adminCookie })
  assert.equal(afterMultiplicityCollision.body.state.state_version, beforeMultiplicityCollision.body.state.state_version)

  const mixedBatch = await sendCommands(baseUrl, playerCookie, multiplicityCampaign, multiplicityKey, [
    { command_type: 'MoveActor', actor_id: 'hero', to: { x: 1, y: 2 } },
    attack(),
  ])
  assert.equal(mixedBatch.status, 403, `${mixedBatch.text}\n${logs}`)
  assert.equal(mixedBatch.body.code, 'PLAYER_COMMAND_FORBIDDEN')
  assert.notEqual(mixedBatch.body.idempotent_replay, true)
  const afterMixedBatch = await request(baseUrl, `/api/rooms/${multiplicityCampaign}`, { cookie: adminCookie })
  assert.equal(afterMixedBatch.body.state.state_version, beforeMultiplicityCollision.body.state.state_version)

  const summonCampaign = 'ATTACK-SUMMON'
  await createCampaign(baseUrl, adminCookie, summonCampaign, { enemyHp: 1_000, activeActor: 'summon', withSummon: true })
  const summonKey = 'summon-attack'
  const summonCommand = attack({ actor_id: 'summon' })
  const summonFirst = await sendCommands(baseUrl, playerCookie, summonCampaign, summonKey, [summonCommand])
  assert.equal(summonFirst.status, 200, `${summonFirst.text}\n${logs}`)
  const summonAttack = summonFirst.body.mechanics.find((event) => event.event_type === 'AttackResolved' && event.actor_id === 'summon')
  assert.ok(summonAttack)
  assert.equal(summonAttack.payload.target_id, 'enemy')

  const adminCampaign = 'ATTACK-ADMIN'
  await createCampaign(baseUrl, adminCookie, adminCampaign, { enemyHp: 1_000 })
  // Переключаем ход непосредственно через append-only Event Store, не вызывая
  // room-save: иначе координатор немедленно исполнит ход NPC раньше HTTP-запроса.
  const adminStore = new FileEventStore({
    rootDir: join(storage, 'engine'),
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
    mapStore: new MapStore({ rootDir: join(storage, 'engine') }),
  })
  const adminBeforeTurn = await adminStore.load(adminCampaign)
  await adminStore.commit({
    campaign_id: adminCampaign,
    expected_state_version: adminBeforeTurn.state_version,
    idempotency_key: 'admin-enemy-turn',
    command_id: 'admin-enemy-turn',
    events: [{ event_type: 'TurnStarted', payload: { round: 1, active_index: 1 }, target_ids: ['enemy'] }],
  })
  const adminEnemyTurn = await adminStore.load(adminCampaign)
  assert.equal(adminEnemyTurn.state.mechanics.combat.initiative[adminEnemyTurn.state.mechanics.combat.active_index].actor_id, 'enemy')
  const adminKey = 'admin-fingerprint'
  const adminCommand = attack({
    actor_id: 'enemy',
    target_id: 'hero',
    request_fingerprint: 'client-controlled-fingerprint',
    attack_modifier: 999,
    damage_expression: '999d999+999',
  })
  const adminFirst = await sendCommands(baseUrl, adminCookie, adminCampaign, adminKey, [adminCommand])
  assert.equal(adminFirst.status, 200, `${adminFirst.text}\n${logs}`)
  const adminAttackEvent = adminFirst.body.mechanics.find((event) => event.event_type === 'AttackResolved')
  assert.ok(adminAttackEvent)
  assert.equal(adminAttackEvent.actor_id, 'enemy')
  assert.equal(adminAttackEvent.payload.target_id, 'hero')
  assert.notEqual(adminAttackEvent.payload.request_fingerprint, 'client-controlled-fingerprint')
  assert.equal(adminAttackEvent.payload.modifier, 7)

  const adminReplay = await sendCommands(baseUrl, adminCookie, adminCampaign, adminKey, [
    attack({ actor_id: 'enemy', target_id: 'hero', request_fingerprint: 'another-client-fingerprint', attack_modifier: -999 }),
  ])
  assert.equal(adminReplay.status, 200, `${adminReplay.text}\n${logs}`)
  assert.equal(adminReplay.body.idempotent_replay, true)
  const beforeAdminCollision = await request(baseUrl, `/api/rooms/${adminCampaign}`, { cookie: adminCookie })
  const adminCollision = await sendCommands(baseUrl, adminCookie, adminCampaign, adminKey, [
    attack({ actor_id: 'enemy', target_id: 'hero', request_fingerprint: adminAttackEvent.payload.request_fingerprint, knock_out: true }),
  ])
  assert.equal(adminCollision.status, 409, `${adminCollision.text}\n${logs}`)
  assert.equal(adminCollision.body.code, 'IDEMPOTENCY_CONFLICT')
  const afterAdminCollision = await request(baseUrl, `/api/rooms/${adminCampaign}`, { cookie: adminCookie })
  assert.equal(afterAdminCollision.body.state.state_version, beforeAdminCollision.body.state.state_version)

  await stopServer(child)
  child = null
  const durableStore = new FileEventStore({
    rootDir: join(storage, 'engine'),
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
    mapStore: new MapStore({ rootDir: join(storage, 'engine') }),
  })
  const lethalEvents = await durableStore.getEvents(lethal.campaignId)
  assert.equal(lethalEvents.filter((event) => event.event_type === 'AttackResolved').length, 1)
  assert.equal(lethalEvents.filter((event) => event.event_type === 'DamageApplied').length, 1)
  const durableAdminAttacks = (await durableStore.getEvents(adminCampaign))
    .filter((event) => event.event_type === 'AttackResolved' && event.actor_id === 'enemy')
  assert.equal(durableAdminAttacks.length, 1)
  assert.notEqual(durableAdminAttacks[0].payload.request_fingerprint, 'client-controlled-fingerprint')
  const beforeSceneAdvance = await durableStore.load(lethal.campaignId)
  await durableStore.commit({
    campaign_id: lethal.campaignId,
    expected_state_version: beforeSceneAdvance.state_version,
    idempotency_key: 'scene-after-lethal-attack',
    command_id: 'scene-after-lethal-attack',
    events: [{
      event_type: 'SceneAdvanced',
      payload: {
        scene: {
          title: 'Next scene',
          location: 'Next scene',
          turn: 2,
          cells: [{ x: 0, y: 0, type: 'floor', revealed: true }],
        },
        party_positions: [{ actor_id: 'hero', x: 0, y: 0 }],
      },
    }],
  })
  const afterSceneAdvance = await durableStore.load(lethal.campaignId)
  assert.equal(afterSceneAdvance.state.enemies.length, 0, 'SceneAdvanced должен удалить прежнюю цель')
  const summonBeforeScene = await durableStore.load(summonCampaign)
  assert.ok(summonBeforeScene.state.actors.some((actor) => actor.id === 'summon'))
  await durableStore.commit({
    campaign_id: summonCampaign,
    expected_state_version: summonBeforeScene.state_version,
    idempotency_key: 'scene-after-summon-attack',
    command_id: 'scene-after-summon-attack',
    events: [{
      event_type: 'SceneAdvanced',
      payload: {
        scene: {
          title: 'Scene without summon',
          location: 'Scene without summon',
          turn: 2,
          cells: [{ x: 0, y: 0, type: 'floor', revealed: true }],
        },
        party_positions: [{ actor_id: 'hero', x: 0, y: 0 }],
      },
    }],
  })
  const summonAfterScene = await durableStore.load(summonCampaign)
  assert.equal(summonAfterScene.state.actors.some((actor) => actor.id === 'summon'), false)

  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)
  const afterRestart = await sendCommands(baseUrl, playerCookie, lethal.campaignId, lethal.key, [lethal.command])
  assert.equal(afterRestart.status, 200, `${afterRestart.text}\n${logs}`)
  assert.equal(afterRestart.body.idempotent_replay, true)
  assert.equal(afterRestart.body.authoritative_state.state_version, afterSceneAdvance.state_version)
  assert.equal(afterRestart.body.authoritative_state.enemies.length, 0)
  const afterReplayEvents = await durableStore.getEvents(lethal.campaignId)
  assert.equal(afterReplayEvents.filter((event) => event.event_type === 'AttackResolved').length, 1)

  const foreignSummonRetry = await sendCommands(baseUrl, foreignCookie, summonCampaign, summonKey, [summonCommand])
  assert.equal(foreignSummonRetry.status, 403, `${foreignSummonRetry.text}\n${logs}`)
  assert.notEqual(foreignSummonRetry.body?.idempotent_replay, true)

  const ownerSummonRetry = await sendCommands(baseUrl, playerCookie, summonCampaign, summonKey, [summonCommand])
  assert.equal(ownerSummonRetry.status, 200, `${ownerSummonRetry.text}\n${logs}`)
  assert.equal(ownerSummonRetry.body.idempotent_replay, true)
  assert.equal(ownerSummonRetry.body.authoritative_state.actors.some((actor) => actor.id === 'summon'), false)

  const absentSummonNewCommand = await sendCommands(baseUrl, playerCookie, summonCampaign, 'summon-new-command', [summonCommand])
  assert.equal(absentSummonNewCommand.status, 403, `${absentSummonNewCommand.text}\n${logs}`)
  assert.equal(absentSummonNewCommand.body.code, 'ACTOR_FORBIDDEN')
  const summonEventsAfterRetries = await durableStore.getEvents(summonCampaign)
  assert.equal(summonEventsAfterRetries.filter((event) => event.event_type === 'AttackResolved' && event.actor_id === 'summon').length, 1)
})

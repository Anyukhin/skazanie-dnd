import assert from 'node:assert/strict'
import test from 'node:test'
import { startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
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
  try { json = text ? JSON.parse(text) : null } catch { /* assertion reports raw response */ }
  return { response, status: response.status, body: json, text }
}

function cookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

function assertStatus(result, expected, log) {
  assert.equal(result.status, expected, `${result.text}\n${log()}`)
  assert.ok(result.body && typeof result.body === 'object', `Expected JSON, got: ${result.text}`)
}

function cells(width = 9, height = 5) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    revealed: true,
  }))
}

function currentActor(state) {
  const combat = state?.mechanics?.combat
  return combat?.initiative?.[combat.active_index]?.actor_id ?? null
}

function durableEncounterProjection(state) {
  return {
    state_version: state.state_version,
    encounter: state.mechanics?.encounter,
    combat: state.mechanics?.combat,
    activePlayerId: state.activePlayerId,
    enemies: (state.enemies ?? []).map((enemy) => ({
      id: enemy.id, hp: enemy.hp, maxHp: enemy.maxHp, armor: enemy.armor,
      x: enemy.x, y: enemy.y, alive: enemy.alive,
    })),
  }
}

async function assemble(baseUrl, session, body) {
  return request(baseUrl, '/api/campaigns/ENCOUNTER-API/encounters/assemble', {
    method: 'POST', cookie: session, body,
  })
}

test('encounter assembly HTTP endpoint is privileged, strict, idempotent and restart-durable', { timeout: runnerTimeout(30_000) }, async (t) => {
  const setupToken = 'encounter-api-setup-token'
  const server = await startTestServer(t, { storagePrefix: 'skazanie-encounter-api-', setupToken })
  const log = server.output
  // restart() берёт новый порт: адрес перечитывается из server.baseUrl.
  let baseUrl = server.baseUrl

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: {
      name: 'Encounter Admin', email: 'admin@encounter-api.test',
      password: 'very-secure-admin-password', setupToken,
    },
  })
  assertStatus(setup, 201, log)
  const adminCookie = cookie(setup)

  const registered = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Encounter Player', email: 'player@encounter-api.test',
      password: 'very-secure-player-password',
    },
  })
  assertStatus(registered, 201, log)
  const playerCookie = cookie(registered)

  const initialState = {
    sessionCode: 'ENCOUNTER-API',
    campaign: 'Encounter API integration',
    partyName: 'Encounter party',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero', name: 'Player', character: 'Aster', level: 1,
      hp: 40, maxHp: 40, armor: 16, speed: 30, proficiency: 2,
      // This deliberately guarantees that every server monster wins initiative.
      abilities: { str: 14, dex: -100, con: 14, int: 10, wis: 12, cha: 10 },
      inventory: [], x: 0, y: 0, online: true,
    }],
    enemies: [],
    scene: {
      title: 'Open field', location: 'Encounter field', mood: 'Tense',
      objective: 'Test encounter assembly', turn: 1, cells: cells(),
    },
    adventure: { chapter: 1, history: [], visitedLocations: ['Encounter field'] },
    mechanics: { positions: { hero: { x: 0, y: 0 } } },
    engine_mode: 'shadow',
  }

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie,
    body: { code: 'ENCOUNTER-API', name: initialState.campaign, state: initialState },
  })
  assertStatus(created, 201, log)

  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  assertStatus(users, 200, log)
  const player = users.body.users.find((candidate) => candidate.email === 'player@encounter-api.test')
  assert.ok(player)
  const assigned = await request(baseUrl, `/api/admin/users/${player.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero'] },
  })
  assertStatus(assigned, 200, log)

  let requestBody = {
    expected_state_version: created.body.state.state_version,
    difficulty: 'easy',
    theme: 'beasts',
    seed: 'encounter-api-stable-seed',
    idempotency_key: 'encounter-api-create-1',
  }

  const playerDenied = await assemble(baseUrl, playerCookie, requestBody)
  assertStatus(playerDenied, 403, log)

  const forged = await assemble(baseUrl, adminCookie, {
    ...requestBody,
    enemies: [{ id: 'forged', hp: 999_999, attackBonus: 999, damageDice: 999, x: 0, y: 0 }],
  })
  assertStatus(forged, 400, log)
  assert.equal(forged.body.code, 'UNEXPECTED_ENCOUNTER_FIELD')

  const stale = await assemble(baseUrl, adminCookie, {
    ...requestBody,
    expected_state_version: 999,
    idempotency_key: 'encounter-api-stale-1',
  })
  assertStatus(stale, 409, log)
  assert.equal(stale.body.code, 'STATE_VERSION_CONFLICT')

  const assembled = await assemble(baseUrl, adminCookie, requestBody)
  assertStatus(assembled, 200, log)
  assert.equal(assembled.body.authoritative_state.mechanics.encounter.status, 'active')
  assert.equal(assembled.body.authoritative_state.mechanics.combat.active, true)
  assert.ok(assembled.body.mechanics.some((event) => event.event_type === 'EncounterCreated'))
  assert.ok(assembled.body.mechanics.some((event) => event.event_type === 'CombatStarted'))
  assert.ok(assembled.body.encounter_proposal.enemies.length > 0)
  assert.ok(assembled.body.encounter_proposal.enemies.every((enemy) => (
    enemy.hp < 100 && enemy.attackBonus < 20 && enemy.damageDice <= 12
      && Number.isSafeInteger(enemy.x) && Number.isSafeInteger(enemy.y)
  )))
  assert.ok(assembled.body.npc_turns.length >= 1, 'enemy-first initiative must be settled by the NPC scheduler')
  assert.ok(assembled.body.npc_turns.every((turn) => assembled.body.authoritative_state.mechanics.encounter.enemy_ids.includes(turn.actor_id)))
  assert.equal(currentActor(assembled.body.authoritative_state), 'hero')
  assert.equal(assembled.body.authoritative_state.activePlayerId, 'hero')

  const playerRoom = await request(baseUrl, '/api/rooms/ENCOUNTER-API', { cookie: playerCookie })
  assertStatus(playerRoom, 200, log)
  assert.equal(playerRoom.body.state.mechanics.encounter.status, 'active')
  assert.ok(playerRoom.body.state.enemies.length > 0)
  for (const enemy of playerRoom.body.state.enemies) {
    assert.equal(Object.hasOwn(enemy, 'hp'), false)
    assert.equal(Object.hasOwn(enemy, 'maxHp'), false)
    assert.equal(Object.hasOwn(enemy, 'armor'), false)
    assert.equal(Object.hasOwn(enemy, 'speed'), false)
    assert.equal(Object.hasOwn(enemy, 'stat_block_id'), false)
    assert.equal(Object.hasOwn(enemy, 'attackBonus'), false)
    assert.equal(Object.hasOwn(enemy, 'damageDice'), false)
    assert.equal(Object.hasOwn(enemy, 'damageBonus'), false)
    assert.ok(['unharmed', 'wounded', 'bloodied', 'critical', 'defeated'].includes(enemy.healthStatus))
  }

  const durableBeforeRestart = durableEncounterProjection(assembled.body.authoritative_state)
  await server.restart()
  baseUrl = server.baseUrl

  const roomAfterRestart = await request(baseUrl, '/api/rooms/ENCOUNTER-API', { cookie: adminCookie })
  assertStatus(roomAfterRestart, 200, log)
  assert.deepEqual(durableEncounterProjection(roomAfterRestart.body.state), durableBeforeRestart)

  const replay = await assemble(baseUrl, adminCookie, requestBody)
  assertStatus(replay, 200, log)
  assert.equal(replay.body.idempotent_replay, true)
  assert.deepEqual(durableEncounterProjection(replay.body.authoritative_state), durableBeforeRestart)

  const conflict = await assemble(baseUrl, adminCookie, {
    ...requestBody,
    difficulty: 'medium',
  })
  assertStatus(conflict, 409, log)
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT')
})

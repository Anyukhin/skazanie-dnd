import assert from 'node:assert/strict'
import test from 'node:test'

import { startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const CAMPAIGN = 'COMBAT-LAB'

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* проверка ниже покажет исходный ответ */ }
  return { response, status: response.status, body: parsed, text }
}

function cookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

function assertStatus(result, expected, log) {
  assert.equal(result.status, expected, `${result.text}\n${log()}`)
  assert.ok(result.body && typeof result.body === 'object', `Expected JSON, received: ${result.text}`)
}

async function command(baseUrl, actorCookie, key, value) {
  return request(baseUrl, `/api/campaigns/${CAMPAIGN}/commands`, {
    method: 'POST',
    cookie: actorCookie,
    body: {
      idempotency_key: key,
      message: `Combat lab: ${value.command_type}`,
      command: value,
    },
  })
}

function cells() {
  return Array.from({ length: 15 }, (_, index) => ({
    x: index % 5,
    y: Math.floor(index / 5),
    type: 'floor',
    revealed: true,
  }))
}

function hero(id, name, x) {
  return {
    id,
    name,
    character: name,
    level: 1,
    hp: 60,
    maxHp: 60,
    armor: 18,
    speed: 30,
    proficiency: 2,
    abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 10, cha: 10 },
    inventory: [],
    online: true,
    x,
    y: 1,
    attackBonus: 7,
    damageDice: 8,
    damageBonus: 4,
    damageType: 'slashing',
    attackRange: 5,
  }
}

function initialState() {
  return {
    sessionCode: CAMPAIGN,
    campaign: 'HTTP combat lab',
    partyName: 'Combat lab party',
    partyMemberIds: ['hero-a', 'hero-b'],
    activePlayerId: 'hero-a',
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [hero('hero-a', 'Ада', 0), hero('hero-b', 'Борис', 2)],
    enemies: [{
      id: 'training-goblin',
      name: 'Учебный гоблин',
      hp: 24,
      maxHp: 24,
      armor: 11,
      speed: 30,
      attackBonus: 2,
      damageDice: 4,
      damageBonus: 1,
      damageType: 'piercing',
      attackRange: 5,
      abilities: { str: 10, dex: 14, con: 10, int: 8, wis: 8, cha: 8 },
      proficiency: 2,
      x: 1,
      y: 1,
      alive: true,
    }],
    scene: {
      title: 'Смежная арена',
      location: 'Combat lab',
      mood: 'Controlled',
      objective: 'Проверить полный бой через HTTP',
      turn: 1,
      cells: cells(),
    },
    tacticalTurn: { sceneTurn: 1, actorId: 'hero-a', movementSpent: 0, actionUsed: false },
    adventure: { chapter: 1, history: [], visitedLocations: ['Combat lab'] },
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    enabled_rule_packs: ['dnd_5e_2014'],
    engine_mode: 'enforce',
  }
}

function activeActor(state) {
  const combat = state?.mechanics?.combat
  return combat?.initiative?.[combat.active_index]?.actor_id ?? null
}

function livingEnemy(state) {
  return (state.enemies ?? []).find((enemy) => enemy.alive !== false) ?? null
}

test('стенд проводит ограниченный бой двух игроков через HTTP и проверяет идемпотентность атаки', { timeout: runnerTimeout(120_000) }, async (t) => {
  const setupToken = 'combat-lab-setup-token'
  const server = await startTestServer(t, { storagePrefix: 'skazanie-combat-lab-', setupToken })
  const baseUrl = server.baseUrl

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Combat lab setup', email: 'admin@combat-lab.test', password: 'secure-admin-password', setupToken },
  })
  assertStatus(admin, 201, server.output)
  const adminCookie = cookie(admin)

  const account = async (suffix, name) => {
    const result = await request(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { name, email: `${suffix}@combat-lab.test`, password: `secure-${suffix}-password` },
    })
    assertStatus(result, 201, server.output)
    return { id: result.body.user.id, cookie: cookie(result) }
  }
  const playerA = await account('player-a', 'Игрок А')
  const playerB = await account('player-b', 'Игрок Б')

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: adminCookie,
    body: { code: CAMPAIGN, name: 'HTTP combat lab', state: initialState() },
  })
  assertStatus(created, 201, server.output)
  assert.equal(created.body.state.ruleset_id, 'dnd_5e_2014')
  assert.equal(created.body.state.ruleset_version, '2014.1.0')
  assert.deepEqual(created.body.state.enabled_rule_packs, ['dnd_5e_2014'])

  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  assertStatus(users, 200, server.output)
  const assign = async (user, heroId) => {
    const result = await request(baseUrl, `/api/admin/users/${user.id}`, {
      method: 'PATCH', cookie: adminCookie, body: { heroIds: [heroId] },
    })
    assertStatus(result, 200, server.output)
  }
  await assign(playerA, 'hero-a')
  await assign(playerB, 'hero-b')

  const cookies = new Map([['hero-a', playerA.cookie], ['hero-b', playerB.cookie]])
  const started = await command(baseUrl, playerA.cookie, 'combat-lab-start-1', {
    command_type: 'StartCombat', actor_id: 'hero-a',
  })
  assertStatus(started, 200, server.output)
  assert.ok(started.body.authoritative_state?.mechanics?.combat?.active)

  const beforeForeignCommand = await request(baseUrl, `/api/rooms/${CAMPAIGN}`, { cookie: playerB.cookie })
  assertStatus(beforeForeignCommand, 200, server.output)
  const foreignVersion = beforeForeignCommand.body.state.state_version
  const foreignCommand = await command(baseUrl, playerB.cookie, 'combat-lab-foreign-actor-1', {
    command_type: 'EndTurn', actor_id: 'hero-a',
  })
  assertStatus(foreignCommand, 403, server.output)
  assert.equal(foreignCommand.body.code, 'ACTOR_FORBIDDEN')
  const afterForeignCommand = await request(baseUrl, `/api/rooms/${CAMPAIGN}`, { cookie: playerB.cookie })
  assertStatus(afterForeignCommand, 200, server.output)
  assert.equal(afterForeignCommand.body.state.state_version, foreignVersion, 'отказ чужому actor_id не должен менять версию состояния')

  let state = started.body.authoritative_state
  const journal = [...(started.body.mechanics ?? [])]
  let attackCount = 0
  let endTurnCount = 0
  let reactionCount = 0
  let attackReplayChecked = false

  // ponytail: фиксированный предел ловит зависший бой; увеличивать его следует только после воспроизводимого длинного боя.
  for (let step = 0; step < 80 && state.mechanics?.combat?.active; step += 1) {
    const combat = state.mechanics.combat
    if (combat.reaction_window) {
      const actorId = String(combat.reaction_window.actor_id ?? '')
      const actorCookie = cookies.get(actorId)
      assert.ok(actorCookie, `reaction actor ${actorId} must belong to a player`)
      const declined = await command(baseUrl, actorCookie, `combat-lab-reaction-${step}`, {
        command_type: 'UseCombatAction', actor_id: actorId, action_id: 'decline-reaction',
      })
      assertStatus(declined, 200, server.output)
      reactionCount += 1
      journal.push(...(declined.body.mechanics ?? []))
      state = declined.body.authoritative_state
      continue
    }

    const actorId = String(activeActor(state) ?? '')
    assert.ok(cookies.has(actorId), `NPC scheduler must leave a player active, got ${actorId}`)
    const actorCookie = cookies.get(actorId)
    const target = livingEnemy(state)
    assert.ok(target, 'an active combat must have a living target')
    const attackKey = `combat-lab-attack-${step}`
    const attackCommand = { command_type: 'MakeAttack', actor_id: actorId, target_id: target.id }
    const attacked = await command(baseUrl, actorCookie, attackKey, attackCommand)
    assertStatus(attacked, 200, server.output)
    attackCount += 1
    journal.push(...(attacked.body.mechanics ?? []))
    const attackedState = attacked.body.authoritative_state

    if (!attackReplayChecked) {
      const replay = await command(baseUrl, actorCookie, attackKey, attackCommand)
      assertStatus(replay, 200, server.output)
      assert.equal(replay.body.idempotent_replay, true)
      assert.equal(replay.body.authoritative_state.state_version, attackedState.state_version)
      attackReplayChecked = true
    }

    state = attackedState
    if (!state.mechanics?.combat?.active) break

    const ended = await command(baseUrl, actorCookie, `combat-lab-end-${step}`, {
      command_type: 'EndTurn', actor_id: actorId,
    })
    assertStatus(ended, 200, server.output)
    endTurnCount += 1
    journal.push(...(ended.body.mechanics ?? []))
    state = ended.body.authoritative_state
  }

  assert.equal(state.mechanics?.combat?.active, false, `combat did not finish within 80 steps: ${JSON.stringify(state.mechanics?.combat)}`)
  assert.equal(livingEnemy(state), null, 'the automated party must defeat the training enemy')
  assert.ok(attackCount > 0)
  assert.ok(endTurnCount > 0)
  assert.equal(attackReplayChecked, true)

  const eventTypes = new Set(journal.map((event) => event.event_type))
  for (const required of ['CombatStarted', 'AttackResolved', 'DamageApplied', 'TurnEnded', 'CombatEnded']) {
    assert.ok(eventTypes.has(required), `combat journal is missing ${required}`)
  }
  assert.ok(journal.length > 5, 'combat journal must contain more than the opening event')
  assert.ok(journal.every((event) => event.event_id), 'every journal event needs a durable event_id')
  if (reactionCount > 0) assert.ok(eventTypes.has('ReactionWindowClosed'))
})

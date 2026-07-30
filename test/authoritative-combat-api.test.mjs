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
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
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
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: setupToken,
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
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not stop')), 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, log) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`Test server exited with ${child.exitCode}\n${log()}`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return response.json()
    } catch { /* the listener is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Test server did not become healthy\n${log()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const headers = { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { Cookie: cookie } : {}) }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* assertion below reports the raw body */ }
  return { response, status: response.status, body: json, text }
}

function sessionCookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

function assertStatus(result, expected, log) {
  assert.equal(result.status, expected, `${result.text}\n${log()}`)
  assert.ok(result.body && typeof result.body === 'object', `Expected JSON, received: ${result.text}`)
}

function cells() {
  const result = []
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 9; x += 1) {
      result.push({
        x,
        y,
        type: x === 7 ? 'wall' : 'floor',
        revealed: true,
        ...(x === 1 && y === 1 ? { feature: 'enemy' } : {}),
      })
    }
  }
  return result
}

function currentActor(state) {
  const combat = state?.mechanics?.combat
  return combat?.initiative?.[combat.active_index]?.actor_id ?? null
}

function actor(state, id) {
  return [...(state?.players ?? []), ...(state?.enemies ?? []), ...(state?.actors ?? [])]
    .find((candidate) => String(candidate.id) === id)
}

function event(result, type, actorId = undefined) {
  return (result?.mechanics ?? []).find((candidate) => candidate.event_type === type
    && (actorId === undefined || candidate.actor_id === actorId))
}

function events(result, type, actorId = undefined) {
  return (result?.mechanics ?? []).filter((candidate) => candidate.event_type === type
    && (actorId === undefined || candidate.actor_id === actorId))
}

function stableCombatProjection(state) {
  const project = (candidate) => ({
    id: candidate.id,
    hp: candidate.hp,
    maxHp: candidate.maxHp,
    x: candidate.x,
    y: candidate.y,
    alive: candidate.alive,
  })
  return {
    state_version: state.state_version,
    activePlayerId: state.activePlayerId,
    tacticalTurn: state.tacticalTurn,
    players: (state.players ?? []).map(project),
    enemies: (state.enemies ?? []).map(project),
    combat: state.mechanics?.combat,
  }
}

async function command(baseUrl, cookie, idempotencyKey, value) {
  return request(baseUrl, '/api/campaigns/AUTH-COMBAT/commands', {
    method: 'POST',
    cookie,
    body: {
      idempotency_key: idempotencyKey,
      message: `HTTP integration: ${value.command_type}`,
      command: value,
    },
  })
}

test('player combat API is server-authoritative, bounded, and durable across restart', { timeout: 30_000 }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-authoritative-combat-'))
  const setupToken = 'authoritative-combat-setup-token'
  let logs = ''
  let child = null
  const log = () => logs
  const appendLog = (chunk) => { logs += chunk }
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })

  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, setupToken, appendLog })
  const health = await waitForHealth(baseUrl, child, log)
  assert.equal(health.configured, false)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: {
      name: 'Combat Admin',
      email: 'admin@authoritative-combat.test',
      password: 'very-secure-admin-password',
      setupToken,
    },
  })
  assertStatus(setup, 201, log)
  const adminCookie = sessionCookie(setup)
  assert.ok(adminCookie)

  const registered = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Combat Player',
      email: 'player@authoritative-combat.test',
      password: 'very-secure-player-password',
    },
  })
  assertStatus(registered, 201, log)
  const playerCookie = sessionCookie(registered)
  assert.ok(playerCookie)

  const initialState = {
    sessionCode: 'AUTH-COMBAT',
    campaign: 'Authoritative combat integration',
    partyName: 'HTTP party',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [{
      id: 'hero',
      name: 'Player',
      character: 'Aster',
      hp: 60,
      maxHp: 60,
      armor: 18,
      speed: 30,
      proficiency: 2,
      abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 10 },
      inventory: [],
      online: true,
      x: 0,
      y: 1,
      // This is trusted campaign data. It deliberately differs from STR + proficiency (+5).
      attackBonus: 7,
      damageDice: 6,
      damageBonus: 2,
      damageType: 'slashing',
      attackRange: 5,
    }],
    enemies: [{
      id: 'sentinel',
      name: 'Stone Sentinel',
      hp: 60,
      maxHp: 60,
      armor: 11,
      speed: 30,
      attackBonus: 4,
      damageDice: 4,
      damageBonus: 1,
      damageType: 'bludgeoning',
      attackRange: 5,
      abilities: { str: 14, dex: 12, con: 14, int: 6, wis: 10, cha: 5 },
      proficiency: 2,
      x: 1,
      y: 1,
      alive: true,
    }],
    scene: {
      title: 'Test arena',
      location: 'Isolated arena',
      mood: 'Controlled',
      objective: 'Exercise the combat API',
      turn: 1,
      cells: cells(),
    },
    tacticalTurn: { sceneTurn: 1, actorId: 'hero', movementSpent: 0, actionUsed: false },
    adventure: { chapter: 1, history: [], visitedLocations: ['Isolated arena'] },
    engine_mode: 'enforce',
  }

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: adminCookie,
    body: { code: 'AUTH-COMBAT', name: initialState.campaign, state: initialState },
  })
  assertStatus(created, 201, log)

  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  assertStatus(users, 200, log)
  const playerUser = users.body.users.find((candidate) => candidate.email === 'player@authoritative-combat.test')
  assert.ok(playerUser)
  const assigned = await request(baseUrl, `/api/admin/users/${playerUser.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { heroIds: ['hero'] },
  })
  assertStatus(assigned, 200, log)
  assert.deepEqual(assigned.body.user.heroIds, ['hero'])

  const retiredMode = await request(baseUrl, '/api/campaigns/AUTH-COMBAT/engine-mode', {
    method: 'PATCH',
    cookie: adminCookie,
    body: { mode: 'legacy' },
  })
  assertStatus(retiredMode, 410, log)
  assert.equal(retiredMode.body.code, 'ENGINE_MODE_RETIRED')

  const roomBeforeTamper = await request(baseUrl, '/api/rooms/AUTH-COMBAT', { cookie: playerCookie })
  assertStatus(roomBeforeTamper, 200, log)
  const tamperedState = structuredClone(roomBeforeTamper.body.state)
  tamperedState.players[0].attackBonus = 100
  tamperedState.players[0].armor = 100
  tamperedState.enemies[0].hp = 0
  tamperedState.enemies[0].alive = false
  tamperedState.mechanics = { combat: { active: true, round: 99, active_index: 0, initiative: [{ actor_id: 'hero', total: 999 }] } }
  const retiredProjectionMutation = await request(baseUrl, '/api/rooms/AUTH-COMBAT', {
    method: 'PUT',
    cookie: playerCookie,
    body: { state: tamperedState, baseVersion: roomBeforeTamper.body.version },
  })
  assertStatus(retiredProjectionMutation, 410, log)
  assert.equal(retiredProjectionMutation.body.code, 'ROOM_MUTATION_RETIRED')

  const attackBeforeInitiative = await command(baseUrl, playerCookie, 'attack-before-combat-1', {
    command_type: 'MakeAttack',
    actor_id: 'hero',
    target_id: 'sentinel',
  })
  assertStatus(attackBeforeInitiative, 400, log)
  assert.equal(attackBeforeInitiative.body.code, 'COMBAT_NOT_ACTIVE')

  // A regular player starts combat. Participants and initiative modifiers are server-derived.
  const started = await command(baseUrl, playerCookie, 'combat-start-1', {
    command_type: 'StartCombat',
    actor_id: 'hero',
  })
  assertStatus(started, 200, log)
  const startState = started.body.authoritative_state
  assert.ok(startState?.mechanics?.combat?.active)
  assert.deepEqual(
    new Set(startState.mechanics.combat.initiative.map((entry) => entry.actor_id)),
    new Set(['hero', 'sentinel']),
  )
  const combatStarted = event(started.body, 'CombatStarted')
  assert.ok(combatStarted)
  assert.ok(combatStarted.target_ids.includes('sentinel'))
  assert.equal(currentActor(startState), 'hero', 'bounded NPC scheduling must hand control to a PC')
  assert.equal(startState.activePlayerId, 'hero')
  assert.ok((started.body.mechanics ?? []).length <= 20, 'start scheduling must be bounded')
  assert.ok((started.body.npc_turns ?? []).length <= 4, 'start scheduling must not loop NPC turns')
  let clockRoom = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    clockRoom = await request(baseUrl, '/api/rooms/AUTH-COMBAT', { cookie: playerCookie })
    assertStatus(clockRoom, 200, log)
    if (clockRoom.body.state.turn_clock) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.deepEqual(clockRoom.body.state.turn_clock.actor_ids, ['hero'])
  assert.ok(Date.parse(clockRoom.body.state.turn_clock.deadline_at) > Date.parse(clockRoom.body.state.turn_clock.started_at))

  const beforeRejected = await request(baseUrl, '/api/rooms/AUTH-COMBAT', { cookie: playerCookie })
  assertStatus(beforeRejected, 200, log)
  const rejectedVersion = beforeRejected.body.state.state_version
  const rejectedEnemyStatus = actor(beforeRejected.body.state, 'sentinel').healthStatus
  assert.equal(actor(beforeRejected.body.state, 'sentinel').hp, undefined)
  assert.equal(actor(beforeRejected.body.state, 'sentinel').maxHp, undefined)
  assert.equal(actor(beforeRejected.body.state, 'sentinel').armor, undefined)
  const rejectedHeroPosition = { x: actor(beforeRejected.body.state, 'hero').x, y: actor(beforeRejected.body.state, 'hero').y }

  const rawDamage = await command(baseUrl, playerCookie, 'forbidden-damage-1', {
    command_type: 'ApplyDamage',
    actor_id: 'hero',
    target_id: 'sentinel',
    amount: 999_999,
    damage_type: 'force',
  })
  assertStatus(rawDamage, 403, log)
  assert.match(String(rawDamage.body.code), /PLAYER.*COMMAND.*FORBIDDEN|COMMAND.*FORBIDDEN/u)

  const foreignActor = await command(baseUrl, playerCookie, 'foreign-actor-1', {
    command_type: 'MoveActor',
    actor_id: 'sentinel',
    to: { x: 2, y: 1 },
  })
  assertStatus(foreignActor, 403, log)
  assert.match(String(foreignActor.body.code), /ACTOR.*FORBIDDEN/u)

  const throughWall = await command(baseUrl, playerCookie, 'move-wall-1', {
    command_type: 'MoveActor',
    actor_id: 'hero',
    to: { x: 8, y: 1 },
    // A client-supplied distance must not make an unreachable destination legal.
    distance: 0,
  })
  assertStatus(throughWall, 400, log)
  assert.match(String(throughWall.body.code), /PATH.*BLOCKED|INVALID.*DESTINATION/u)

  const overSpeed = await command(baseUrl, playerCookie, 'move-speed-1', {
    command_type: 'MoveActor',
    actor_id: 'hero',
    to: { x: 6, y: 0 },
    // The shortest legal route is seven cells / 35 ft, while the actor has 30 ft.
    distance: 5,
  })
  assertStatus(overSpeed, 400, log)
  assert.match(String(overSpeed.body.code), /SPEED|MOVEMENT/u)

  const afterRejected = await request(baseUrl, '/api/rooms/AUTH-COMBAT', { cookie: playerCookie })
  assertStatus(afterRejected, 200, log)
  assert.equal(afterRejected.body.state.state_version, rejectedVersion)
  assert.equal(actor(afterRejected.body.state, 'sentinel').healthStatus, rejectedEnemyStatus)
  assert.deepEqual(
    { x: actor(afterRejected.body.state, 'hero').x, y: actor(afterRejected.body.state, 'hero').y },
    rejectedHeroPosition,
  )

  const adminMoved = await command(baseUrl, adminCookie, 'admin-authoritative-move-1', {
    command_type: 'MoveActor',
    actor_id: 'hero',
    to: { x: 0, y: 0 },
    distance: 0,
  })
  assertStatus(adminMoved, 200, log)
  const adminMoveEvent = event(adminMoved.body, 'ActorMoved', 'hero')
  assert.equal(adminMoveEvent.payload.distance, 5)
  assert.equal(adminMoveEvent.payload.movement_spent, 5)

  const movedBack = await command(baseUrl, playerCookie, 'player-authoritative-move-1', {
    command_type: 'MoveActor',
    actor_id: 'hero',
    to: { x: 0, y: 1 },
    distance: 0,
  })
  assertStatus(movedBack, 200, log)
  const moveBackEvent = event(movedBack.body, 'ActorMoved', 'hero')
  assert.equal(moveBackEvent.payload.distance, 5)
  assert.equal(moveBackEvent.payload.movement_spent, 10)

  // Hostile client mechanics are present on purpose. A successful request must use the
  // trusted +7 / 1d6+2 profile and the target's real AC, never any value below.
  const attacked = await command(baseUrl, playerCookie, 'server-profile-attack-1', {
    command_type: 'MakeAttack',
    actor_id: 'hero',
    target_id: 'sentinel',
    attack_modifier: 100,
    armor_class: 0,
    damage_expression: '100d100+10000',
    damage_amount: 999_999,
    damage_type: 'force',
  })
  assertStatus(attacked, 200, log)
  const attackState = attacked.body.authoritative_state
  const attackResolved = event(attacked.body, 'AttackResolved', 'hero')
  assert.ok(attackResolved)
  assert.equal(attackResolved.payload.target_id, 'sentinel')
  assert.equal(attackResolved.payload.modifier, 7)
  assert.equal(attackResolved.payload.armor_class, undefined)
  assert.ok(Number.isInteger(attackResolved.payload.kept) && attackResolved.payload.kept >= 1 && attackResolved.payload.kept <= 20)
  assert.equal(attackResolved.payload.total, attackResolved.payload.kept + 7)
  assert.equal(typeof attackResolved.payload.hit, 'boolean')

  const attackExplanation = await request(baseUrl, attacked.body.explanation_url, { cookie: playerCookie })
  assertStatus(attackExplanation, 200, log)
  const validatedAttack = attackExplanation.body.commands.find((candidate) => candidate.command_type === 'MakeAttack')
  assert.ok(validatedAttack)
  assert.equal(validatedAttack.attack_modifier, 7)
  assert.equal(validatedAttack.damage_expression, '1d6+2')
  assert.ok(validatedAttack.armor_class === undefined || validatedAttack.armor_class === 11)
  assert.notEqual(validatedAttack.damage_type, 'force')
  const serverAttackRoll = attackExplanation.body.rolls.find((roll) => roll.purpose === 'attack' && roll.actor_id === 'hero')
  assert.ok(serverAttackRoll)
  assert.equal(serverAttackRoll.expression, '1d20+7')
  assert.equal(serverAttackRoll.total, serverAttackRoll.kept + 7)

  const attackDamage = event(attacked.body, 'DamageApplied', 'hero')
  const damageRoll = attackExplanation.body.rolls.find((roll) => roll.purpose === 'damage' && roll.actor_id === 'hero')
  if (attackResolved.payload.hit) {
    assert.ok(attackDamage)
    assert.ok(damageRoll)
    assert.equal(damageRoll.expression, attackResolved.payload.critical ? '2d6+2' : '1d6+2')
    assert.equal(damageRoll.total, damageRoll.dice.reduce((sum, die) => sum + die, 2))
    assert.ok(damageRoll.dice.every((die) => Number.isInteger(die) && die >= 1 && die <= 6))
    assert.equal(attackDamage.payload.raw_amount, damageRoll.total)
    assert.equal(attackDamage.payload.hp_before, undefined)
    assert.equal(attackDamage.payload.hp_after, undefined)
    assert.equal(actor(attackState, 'sentinel').hp, undefined)
  } else {
    assert.equal(attackDamage, undefined)
    assert.equal(damageRoll, undefined)
    assert.equal(actor(attackState, 'sentinel').hp, undefined)
  }
  assert.equal(actor(attackState, 'sentinel').alive, true, 'the durable enemy fixture must survive one attack')

  const heroHpBeforeNpc = actor(attackState, 'hero').hp
  const ended = await command(baseUrl, playerCookie, 'end-turn-with-npc-1', {
    command_type: 'EndTurn',
    actor_id: 'hero',
  })
  assertStatus(ended, 200, log)
  assert.ok(ended.body.narration_message_id)
  assert.doesNotMatch(ended.body.narration, /TurnEnded|TurnStarted|ActorMoved|AttackResolved/u)
  assert.match(ended.body.narration, /атаку|перемещ|урон|ход/u)
  assert.ok((ended.body.mechanics ?? []).length <= 20, 'one player end turn must have a bounded event batch')
  assert.ok((ended.body.npc_turns ?? []).length >= 1, 'the scheduler must report the intervening NPC turn')
  assert.ok(ended.body.npc_turns.length <= 4, 'the NPC scheduler must be bounded')
  assert.ok(event(ended.body, 'TurnEnded', 'hero'))
  assert.ok(event(ended.body, 'TurnEnded', 'sentinel'))
  const npcAttack = event(ended.body, 'AttackResolved', 'sentinel')
  assert.ok(npcAttack, 'an adjacent living NPC must take its legal attack')
  assert.equal(npcAttack.payload.target_id, 'hero')
  assert.equal(npcAttack.payload.modifier, undefined)
  assert.equal(npcAttack.payload.kept, undefined)
  assert.equal(npcAttack.payload.armor_class, 18)
  assert.ok(Number.isInteger(npcAttack.payload.total))

  const finalState = ended.body.authoritative_state
  assert.equal(finalState.messages.filter((message) => message.id === ended.body.narration_message_id).length, 1)
  assert.equal(finalState.messages.find((message) => message.id === ended.body.narration_message_id).turnConsumed, true)
  assert.equal(currentActor(finalState), 'hero')
  assert.equal(finalState.activePlayerId, 'hero')
  assert.equal(finalState.tacticalTurn.actorId, 'hero')
  assert.equal(finalState.tacticalTurn.movementSpent, 0)
  assert.equal(finalState.tacticalTurn.actionUsed, false)
  assert.equal(finalState.mechanics.combat.action_economy.hero.action, true)
  const lastTurnStarted = events(ended.body, 'TurnStarted').at(-1)
  assert.ok(lastTurnStarted?.target_ids?.includes('hero'))

  const npcDamage = events(ended.body, 'DamageApplied', 'sentinel').find((candidate) => candidate.target_ids.includes('hero'))
  if (npcAttack.payload.hit) {
    assert.ok(npcDamage)
    assert.equal(npcDamage.payload.hp_before, heroHpBeforeNpc)
    assert.equal(actor(finalState, 'hero').hp, npcDamage.payload.hp_after)
  } else {
    assert.equal(npcDamage, undefined)
    assert.equal(actor(finalState, 'hero').hp, heroHpBeforeNpc)
  }

  const finalRoom = await request(baseUrl, '/api/rooms/AUTH-COMBAT', { cookie: playerCookie })
  assertStatus(finalRoom, 200, log)
  assert.deepEqual(stableCombatProjection(finalRoom.body.state), stableCombatProjection(finalState))

  // Restart the actual process against the same storage. Auth, compatibility room projection,
  // event state, and an idempotent replay must all converge on the exact same combat facts.
  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, setupToken, appendLog })
  await waitForHealth(baseUrl, child, log)

  const meAfterRestart = await request(baseUrl, '/api/auth/me', { cookie: playerCookie })
  assertStatus(meAfterRestart, 200, log)
  assert.equal(meAfterRestart.body.user.email, 'player@authoritative-combat.test')
  const roomAfterRestart = await request(baseUrl, '/api/rooms/AUTH-COMBAT', { cookie: playerCookie })
  assertStatus(roomAfterRestart, 200, log)
  assert.deepEqual(stableCombatProjection(roomAfterRestart.body.state), stableCombatProjection(finalState))

  const replayed = await command(baseUrl, playerCookie, 'end-turn-with-npc-1', {
    command_type: 'EndTurn',
    actor_id: 'hero',
  })
  assertStatus(replayed, 200, log)
  assert.equal(replayed.body.idempotent_replay, true)
  assert.equal(replayed.body.narration_message_id, ended.body.narration_message_id)
  assert.equal(replayed.body.authoritative_state.messages.filter((message) => message.id === ended.body.narration_message_id).length, 1)
  assert.deepEqual(stableCombatProjection(replayed.body.authoritative_state), stableCombatProjection(finalState))
  const roomAfterReplay = await request(baseUrl, '/api/rooms/AUTH-COMBAT', { cookie: playerCookie })
  assertStatus(roomAfterReplay, 200, log)
  assert.deepEqual(stableCombatProjection(roomAfterReplay.body.state), stableCombatProjection(finalState))
})

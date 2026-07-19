import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { actorPosition, findActor, shortestTacticalPath } from '../server/rules-engine.mjs'

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'mvp-player-cycle-setup-token', GAME_ENGINE_MODE: 'enforce',
      COOKIE_SECURE: 'false', NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited\n${logs()}`)
    try { const response = await fetch(`${baseUrl}/api/health`); if (response.ok) return }
    catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Test server did not become healthy\n${logs()}`)
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
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* assertion reports text */ }
  return { response, status: response.status, body: parsed, text }
}

const cookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

function hero(index) {
  return {
    id: `mvp-hero-${index + 1}`, name: `Игрок ${index + 1}`, character: `Герой ${index + 1}`,
    role: 'Воин · ур. 1', species: 'Человек', background: 'Странник', backstory: 'Ищет пропавший караван.',
    level: 1, hp: 30, maxHp: 30, armor: 18, speed: 30, proficiency: 2,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], online: true,
    attackBonus: 7, damageDice: 8, damageBonus: 4, damageType: 'slashing', attackRange: 5,
  }
}

function livingEnemies(state) {
  return (state.enemies ?? []).filter((enemy) => enemy.alive !== false && Number(enemy.hp) > 0)
}

function nearestEnemy(state, actorId) {
  const from = actorPosition(state, actorId)
  if (!from) return null
  return livingEnemies(state).map((enemy) => {
    const to = actorPosition(state, enemy.id)
    return { enemy, distance: to ? Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * 5 : Infinity }
  }).sort((left, right) => left.distance - right.distance || String(left.enemy.id).localeCompare(String(right.enemy.id)))[0] ?? null
}

function approachPath(state, actorId, targetId) {
  const target = actorPosition(state, targetId)
  if (!target) return null
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => shortestTacticalPath(state, actorId, { x: target.x + dx, y: target.y + dy }))
    .filter((path) => Array.isArray(path)).sort((left, right) => left.length - right.length)[0] ?? null
}

async function playerCommand(baseUrl, cookieValue, key, commandValue) {
  return request(baseUrl, '/api/campaigns/PLAYER-MVP/commands', {
    method: 'POST', cookie: cookieValue, key,
    body: { idempotency_key: key, message: `UI E2E: ${commandValue.command_type}`, command: commandValue },
  })
}

test('обычные игроки проходят автономную кампанию, полный бой, награды и три сцены', { timeout: 150_000 }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-mvp-player-cycle-'))
  let logs = ''
  let child = null
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })

  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const admin = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Setup only', email: 'setup@mvp.test', password: 'secure-setup-password', setupToken: 'mvp-player-cycle-setup-token',
  } })
  assert.equal(admin.status, 201, admin.text)

  const owner = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Owner', email: 'owner@mvp.test', password: 'secure-owner-password',
  } })
  const guest = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Guest', email: 'guest@mvp.test', password: 'secure-guest-password',
  } })
  assert.equal(owner.status, 201, owner.text)
  assert.equal(guest.status, 201, guest.text)
  const ownerCookie = cookie(owner)
  const guestCookie = cookie(guest)

  const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: ownerCookie, body: {
    code: 'PLAYER-MVP', name: 'Игроки и автономный режиссёр',
    bootstrap: { partyName: 'Четверо', world: { preset: 'Классическое фэнтези' }, players: [0, 1, 2, 3].map(hero) },
  } })
  assert.equal(created.status, 201, created.text)
  assert.equal(created.body.state.players.length, 4)
  assert.deepEqual(created.body.user.heroIds, ['mvp-hero-1', 'mvp-hero-3'])
  assert.equal(created.body.state.worldMemory.quests.length >= 1, true)
  assert.equal(created.body.state.social.npcs.length >= 1, true)

  const joined = await request(baseUrl, '/api/campaigns/PLAYER-MVP/join', { method: 'POST', cookie: guestCookie })
  assert.equal(joined.status, 200, joined.text)
  assert.deepEqual(joined.body.hero_ids, ['mvp-hero-2', 'mvp-hero-4'])
  const joinedAgain = await request(baseUrl, '/api/campaigns/PLAYER-MVP/join', { method: 'POST', cookie: guestCookie })
  assert.equal(joinedAgain.status, 200, joinedAgain.text)
  assert.equal(joinedAgain.body.duplicate, true)

  const ownerRoom = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: ownerCookie })
  const guestRoom = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: guestCookie })
  assert.equal(ownerRoom.status, 200, ownerRoom.text)
  assert.equal(guestRoom.status, 200, guestRoom.text)
  assert.equal(ownerRoom.body.state.state_version, guestRoom.body.state.state_version)

  const forgedIntent = await request(baseUrl, '/api/campaigns/PLAYER-MVP/autonomy/intents', {
    method: 'POST', cookie: ownerCookie, key: 'forged-player-intent',
    body: { type: 'request_encounter', theme: 'beasts', difficulty: 'deadly' },
  })
  assert.equal(forgedIntent.status, 403, forgedIntent.text)

  const intentTypes = []
  let resolvedChecks = 0
  for (let turn = 1; turn <= 4; turn += 1) {
    const key = `player-director-${turn}`
    const advanced = await request(baseUrl, '/api/campaigns/PLAYER-MVP/autonomy/advance', {
      method: 'POST', cookie: ownerCookie, key, body: { idempotency_key: key, player_action: 'Продолжить приключение' },
    })
    assert.equal(advanced.status, 200, advanced.text)
    assert.equal(advanced.body.admin_commands, 0)
    intentTypes.push(advanced.body.intent.type)
    if (turn === 1) {
      const duplicate = await request(baseUrl, '/api/campaigns/PLAYER-MVP/autonomy/advance', {
        method: 'POST', cookie: ownerCookie, key, body: { idempotency_key: key, player_action: 'Повтор сети' },
      })
      assert.equal(duplicate.status, 200, duplicate.text)
      assert.equal(duplicate.body.duplicate, true)
      assert.equal(duplicate.body.state_version, advanced.body.state_version)
    }
    const playerActions = turn === 1
      ? ['Я внимательно осматриваю следы и ищу скрытый проход.']
      : turn === 2
        ? ['Я убеждаю Миру Ветрокрыл рассказать всё, что она знает.', 'Я запугиваю Миру Ветрокрыл, требуя назвать источник угрозы.']
        : []
    let actionState = advanced.body.state
    for (let actionIndex = 0; actionIndex < playerActions.length; actionIndex += 1) {
      const activeId = String(actionState.activePlayerId)
      const activeCookie = ['mvp-hero-1', 'mvp-hero-3'].includes(activeId) ? ownerCookie : guestCookie
      const action = playerActions[actionIndex]
      const narrated = await request(baseUrl, '/api/narrate', {
        method: 'POST', cookie: activeCookie,
        body: { state: actionState, action, player: activeId, campaignId: 'PLAYER-MVP', idempotency_key: `player-check-${turn}-${actionIndex + 1}` },
      })
      assert.equal(narrated.status, 200, narrated.text)
      assert.ok(narrated.body.mechanics.some((event) => event.event_type === 'AbilityCheckResolved'), `action did not resolve a server check: ${action}; ${JSON.stringify(narrated.body)}`)
      resolvedChecks += 1
      actionState = narrated.body.authoritative_state
      if (turn === 2 && actionIndex === 0) {
        const dialogueVersion = actionState.state_version
        const dialogueCount = actionState.social.conversations.length
        await stopServer(child)
        child = null
        port = await freePort()
        baseUrl = `http://127.0.0.1:${port}`
        child = startServer(port, storage, (chunk) => { logs += chunk })
        await waitForHealth(baseUrl, child, () => logs)
        const restoredDialogue = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: activeCookie })
        assert.equal(restoredDialogue.status, 200, restoredDialogue.text)
        assert.equal(restoredDialogue.body.state.state_version, dialogueVersion)
        assert.equal(restoredDialogue.body.state.social.conversations.length, dialogueCount)
        actionState = restoredDialogue.body.state
      }
    }
  }
  assert.equal(resolvedChecks, 3)
  assert.deepEqual(intentTypes, ['continue_exploration', 'open_social_scene', 'advance_quest_clock', 'request_encounter'])

  const combatRoom = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: guestCookie })
  assert.equal(combatRoom.status, 200, combatRoom.text)
  assert.equal(combatRoom.body.state.players.length, 4)
  assert.ok(combatRoom.body.state.enemies.length >= 3, `expected at least three enemies, received ${combatRoom.body.state.enemies.length}`)
  assert.equal(combatRoom.body.state.mechanics.combat.active, true)
  assert.ok(combatRoom.body.state.mechanics.combat.initiative.length >= 7)

  const stableCombat = structuredClone(combatRoom.body.state.mechanics.combat)
  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)
  const restored = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: guestCookie })
  assert.equal(restored.status, 200, restored.text)
  assert.deepEqual(restored.body.state.mechanics.combat, stableCombat)
  assert.equal(restored.body.state.enemies.length, combatRoom.body.state.enemies.length)

  let battleState = restored.body.state
  let commandIndex = 0
  let playerTurns = 0
  const cookieFor = (actorId) => ['mvp-hero-1', 'mvp-hero-3'].includes(actorId) ? ownerCookie : guestCookie
  for (let attempt = 0; attempt < 160 && battleState.mechanics.combat.active; attempt += 1) {
    const combat = battleState.mechanics.combat
    if (combat.reaction_window) {
      const reactionActorId = String(combat.reaction_window.actor_id ?? '')
      const declined = await playerCommand(baseUrl, cookieFor(reactionActorId), `player-reaction-${++commandIndex}`, {
        command_type: 'UseCombatAction', actor_id: reactionActorId, action_id: 'decline-reaction',
      })
      assert.equal(declined.status, 200, declined.text)
      battleState = declined.body.authoritative_state
      continue
    }
    const actorId = String(combat.initiative[combat.active_index]?.actor_id ?? '')
    const current = findActor(battleState, actorId)
    assert.ok(current, `active actor ${actorId} must exist`)
    assert.ok((battleState.players ?? []).some((heroEntry) => heroEntry.id === actorId), `NPC scheduler left enemy ${actorId} for the browser client`)
    const actorCookie = cookieFor(actorId)

    if (Number(current.hp) > 0 && current.alive !== false) {
      let target = nearestEnemy(battleState, actorId)
      if (target && target.distance > 5) {
        const path = approachPath(battleState, actorId, target.enemy.id)
        const spent = Number(combat.action_economy?.[actorId]?.movement_spent ?? 0)
        const availableSteps = Math.max(0, Math.floor((Number(current.speed) || 30) / 5) - Math.floor(spent / 5))
        if (path?.length && availableSteps > 0) {
          const to = path[Math.min(path.length, availableSteps) - 1]
          const moved = await playerCommand(baseUrl, actorCookie, `player-move-${++commandIndex}`, {
            command_type: 'MoveActor', actor_id: actorId, to,
          })
          assert.equal(moved.status, 200, moved.text)
          battleState = moved.body.authoritative_state
          target = nearestEnemy(battleState, actorId)
        }
      }
      const actionReady = battleState.mechanics.combat.action_economy?.[actorId]?.action !== false
      if (battleState.mechanics.combat.active && target && target.distance <= 5 && actionReady) {
        const attacked = await playerCommand(baseUrl, actorCookie, `player-attack-${++commandIndex}`, {
          command_type: 'MakeAttack', actor_id: actorId, target_id: target.enemy.id,
        })
        assert.equal(attacked.status, 200, attacked.text)
        battleState = attacked.body.authoritative_state
        playerTurns += 1
      }
    }

    if (battleState.mechanics.combat.active) {
      const endedTurn = await playerCommand(baseUrl, actorCookie, `player-end-turn-${++commandIndex}`, {
        command_type: 'EndTurn', actor_id: actorId,
      })
      assert.equal(endedTurn.status, 200, endedTurn.text)
      battleState = endedTurn.body.authoritative_state
    }
  }
  assert.equal(battleState.mechanics.combat.active, false, 'browser-compatible player commands must finish combat')
  assert.ok(playerTurns >= 3, `expected a tactical fight, received ${playerTurns} attacking turns`)
  assert.equal(livingEnemies(battleState).length, 0, 'the party must win the mandatory encounter')

  const continued = await request(baseUrl, '/api/campaigns/PLAYER-MVP/autonomy/advance', {
    method: 'POST', cookie: ownerCookie, key: 'player-after-combat',
    body: { idempotency_key: 'player-after-combat', player_action: 'Забрать добычу, восстановиться и продолжить путь' },
  })
  assert.equal(continued.status, 200, continued.text)
  assert.equal(continued.body.admin_commands, 0)
  assert.equal(continued.body.intent.type, 'end_scene')
  assert.ok(continued.body.reward)
  assert.ok(continued.body.reward.xp > 0)
  assert.ok(continued.body.reward.loot.length >= 1)
  assert.ok(continued.body.state.players.some((entry) => entry.inventory.some((item) => String(item.id).startsWith('loot-'))))
  assert.equal(continued.body.state.mechanics.world_time.elapsed_minutes, 480)
  assert.ok(continued.body.state.players.every((entry) => entry.hp === entry.maxHp), 'post-combat long rest must restore every surviving hero')
  assert.equal(continued.body.state.adventure.chapter, 2)

  const peacefulIntents = []
  let peacefulState = continued.body.state
  for (let step = 1; step <= 6 && peacefulState.adventure.chapter < 3; step += 1) {
    const key = `player-peaceful-scene-${step}`
    const advanced = await request(baseUrl, '/api/campaigns/PLAYER-MVP/autonomy/advance', {
      method: 'POST', cookie: ownerCookie, key, body: { idempotency_key: key, player_action: 'Продолжить расследование без нового боя' },
    })
    assert.equal(advanced.status, 200, advanced.text)
    peacefulIntents.push(advanced.body.intent.type)
    peacefulState = advanced.body.state
  }
  assert.equal(peacefulState.adventure.chapter, 3)
  assert.equal(peacefulIntents.includes('request_encounter'), false, 'second encounter must remain avoidable')
  const finalGuestRoom = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: guestCookie })
  assert.equal(finalGuestRoom.status, 200, finalGuestRoom.text)
  assert.equal(finalGuestRoom.body.state.adventure.chapter, 3)
  assert.equal(finalGuestRoom.body.state.state_version, peacefulState.state_version)
})

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

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Тестовый сервер не остановился')), 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* assertion below reports raw body */ }
  return { status: response.status, body: json, text, response }
}

function cookieFor(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Тестовый сервер завершился с кодом ${child.exitCode}\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return response.json()
    } catch { /* listener ещё запускается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Тестовый сервер не запустился\n${logs()}`)
}

function command(path, cookie, idempotencyKey, value) {
  return request(path, '/api/campaigns/ENERVATION-HTTP/commands', {
    method: 'POST', cookie,
    body: { idempotency_key: idempotencyKey, message: `HTTP Enervation: ${value.command_type}`, command: value },
  })
}

function cells() {
  return Array.from({ length: 400 }, (_, index) => ({
    x: index % 20,
    y: Math.floor(index / 20),
    type: 'floor',
    revealed: true,
  }))
}

function combatState() {
  return {
    sessionCode: 'ENERVATION-HTTP',
    campaign: 'HTTP Enervation',
    partyName: 'Проверка луча',
    partyMemberIds: ['caster'],
    activePlayerId: 'caster',
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    engine_mode: 'enforce',
    players: [{
      id: 'caster', name: 'Caster', character: 'Caster', characterClass: 'wizard', level: 12,
      hp: 20, maxHp: 50, armor: 14, speed: 30, proficiency: 4,
      abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 },
      inventory: [], x: 1, y: 1,
      knownSpellIds: ['enervation'], preparedSpellIds: ['enervation'],
    }],
    enemies: [{
      id: 'target', name: 'Target', hp: 100, maxHp: 100, armor: 12, speed: 30,
      // СЛ волшебника 16; даже d20 + модификатор −5 не достигает её.
      abilities: { str: 10, dex: 1, con: 14 }, x: 3, y: 1, alive: true,
    }],
    scene: { title: 'Enervation arena', location: 'http-enervation', turn: 1, cells: cells() },
    mechanics: {
      resources: { caster: { spell_slots_6: { current: 1, max: 1 } } },
      combat: {
        active: true, round: 1, active_index: 0,
        // Цель остаётся допустимой целью, но без отдельного хода; это даёт
        // HTTP-сценарию обычный EndTurn → следующий ход caster без NPC шума.
        initiative: [{ actor_id: 'caster', total: 20 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  }
}

function assertStatus(result, expected, logs) {
  assert.equal(result.status, expected, `${result.text.slice(0, 2000)}\n${logs().slice(-2000)}`)
  assert.ok(result.body && typeof result.body === 'object', `Ожидался JSON: ${result.text}`)
}

test('Enervation проходит обычный HTTP command path, права и idempotency', { timeout: 45_000 }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-enervation-api-'))
  const setupToken = 'enervation-http-setup'
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  let logsText = ''
  const logs = () => logsText
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: setupToken, GAME_ENGINE_MODE: 'enforce', COOKIE_SECURE: 'false', NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { logsText += String(chunk) })
  child.stderr.on('data', (chunk) => { logsText += String(chunk) })
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })
  await waitForHealth(baseUrl, child, logs)

  const setup = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Enervation admin', email: 'enervation-admin@enervation.test', password: 'enervation-admin-password', setupToken,
  } })
  assertStatus(setup, 201, logs)
  const adminCookie = cookieFor(setup)
  const registration = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Enervation player', email: 'enervation-player@enervation.test', password: 'enervation-player-password',
  } })
  assertStatus(registration, 201, logs)
  const playerCookie = cookieFor(registration)
  const guestRegistration = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Enervation guest', email: 'enervation-guest@enervation.test', password: 'enervation-guest-password',
  } })
  assertStatus(guestRegistration, 201, logs)
  const guestCookie = cookieFor(guestRegistration)

  const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: adminCookie, body: {
    code: 'ENERVATION-HTTP', name: 'HTTP Enervation', state: combatState(),
  } })
  assertStatus(created, 201, logs)
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  assertStatus(users, 200, logs)
  const player = users.body.users.find((user) => user.email === 'enervation-player@enervation.test')
  assert.ok(player)
  const assigned = await request(baseUrl, `/api/admin/users/${player.id}`, { method: 'PATCH', cookie: adminCookie, body: { heroIds: ['caster'] } })
  assertStatus(assigned, 200, logs)

  const cast = await command(baseUrl, playerCookie, 'enervation-http-cast', {
    command_type: 'CastSpell', actor_id: 'caster', spell_id: 'enervation', target_id: 'target', target_ids: ['target'], slot_level: 6,
  })
  assertStatus(cast, 200, logs)
  const save = cast.body.mechanics.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(save?.payload.saved, false)
  const initialDamage = cast.body.mechanics.find((event) => event.event_type === 'DamageApplied' && event.payload?.spell_id === 'enervation')
  const initialHealing = cast.body.mechanics.find((event) => event.event_type === 'HealingApplied' && event.payload?.spell_id === 'enervation')
  assert.ok(initialDamage)
  assert.ok(initialHealing)
  const continuation = cast.body.authoritative_state.players.find((actor) => actor.id === 'caster')?.combatActions
    ?.find((action) => action.id === 'enervation-repeat')
  assert.equal(continuation?.iconId, 'enervation')
  assert.ok(cast.body.authoritative_state.players.find((actor) => actor.id === 'caster')?.combatActions?.some((action) => action.id === 'enervation-repeat'))

  const nextTurn = await command(baseUrl, playerCookie, 'enervation-http-next-turn', {
    command_type: 'EndTurn', actor_id: 'caster',
  })
  assertStatus(nextTurn, 200, logs)

  const foreign = await command(baseUrl, guestCookie, 'enervation-http-foreign', {
    command_type: 'UseCombatAction', actor_id: 'caster', action_id: 'enervation-repeat', target_id: 'target', target_ids: ['target'],
  })
  assertStatus(foreign, 403, logs)

  const repeat = await command(baseUrl, playerCookie, 'enervation-http-repeat', {
    command_type: 'UseCombatAction', actor_id: 'caster', action_id: 'enervation-repeat', target_id: 'target', target_ids: ['target'],
  })
  assertStatus(repeat, 200, logs)
  assert.ok(repeat.body.mechanics.some((event) => event.event_type === 'CombatActionUsed' && event.payload?.action_id === 'enervation-repeat'))
  assert.ok(repeat.body.mechanics.some((event) => event.event_type === 'DamageApplied' && event.payload?.continuation === true))
  assert.ok(repeat.body.mechanics.some((event) => event.event_type === 'HealingApplied' && event.payload?.continuation === true))
  assert.equal(repeat.body.mechanics.some((event) => event.event_type === 'ResourceSpent'), false)
  const replay = await command(baseUrl, playerCookie, 'enervation-http-repeat', {
    command_type: 'UseCombatAction', actor_id: 'caster', action_id: 'enervation-repeat', target_id: 'target', target_ids: ['target'],
  })
  assertStatus(replay, 200, logs)
  assert.equal(replay.body.idempotent_replay, true)
  assert.equal(replay.body.authoritative_state.state_version, repeat.body.authoritative_state.state_version)
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runnerTimeout } from './shared-runner-timeout.mjs'

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function initialState({ combatActive = false, withConcentration = false } = {}) {
  const cells = Array.from({ length: 20 * 8 }, (_, index) => ({ x: index % 20, y: Math.floor(index / 20), type: 'floor', revealed: true }))
  const player = (id, characterClass, x, y, abilities, preparedSpellIds = []) => ({
    id, character: id, characterClass, level: 5, characterSetupRequired: false,
    hp: 30, maxHp: 30, armor: 14, speed: 30, proficiency: 4, abilities,
    inventory: [], knownSpellIds: preparedSpellIds, preparedSpellIds, x, y,
  })
  const players = [
    player('hero-slot-1', 'cleric', 1, 1, { str: 10, dex: 12, con: 12, int: 10, wis: 18, cha: 10 }, ['prayer-of-healing']),
    player('hero-slot-2', 'wizard', 1, 1, { str: 8, dex: 14, con: 12, int: 20, wis: 10, cha: 10 }, ['spray-of-cards']),
    player('ally', 'fighter', 2, 1, { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }),
    { ...player('undead', 'fighter', 3, 1, { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }), creature_type: 'undead' },
  ]
  players[1].inventory = [{ id: 'wizard-pouch', catalog_id: 'srd_5_2_1:component-pouch', quantity: 1, component_pouch: true }]
  if (combatActive) {
    for (const player of players.filter((entry) => entry.id !== 'hero-slot-2')) { player.x = 10; player.y = 6 }
  }
  const enemies = [
    { id: 'foe', name: 'Цель', creature_type: 'humanoid', hp: 40, maxHp: 40, armor: 10, speed: 30, abilities: { str: 10, dex: 1, con: 10, int: 8, wis: 8, cha: 8 }, x: 3, y: 1, alive: true },
    { id: 'scout', name: 'Разведчик', creature_type: 'humanoid', hp: 40, maxHp: 40, armor: 10, speed: 30, abilities: { str: 10, dex: 50, con: 10, int: 8, wis: 8, cha: 8 }, x: 3, y: 2, alive: true },
  ]
  const actionEconomy = Object.fromEntries([...players.map((entry) => entry.id), ...enemies.map((entry) => entry.id)].map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }]))
  return {
    sessionCode: 'SPELL-SOURCE-API', campaign: 'Spell source API', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'], character_start_level: 5,
    partyMemberIds: players.map((entry) => entry.id), activePlayerId: combatActive ? 'hero-slot-2' : 'hero-slot-1', players, enemies,
    scene: { turn: 1, title: 'Spell source API', location: 'spell-source-api', cells },
    mechanics: {
      world_time: { elapsed_minutes: 0, elapsed_seconds: 0, clock_version: 2 },
      ...(withConcentration ? {
        concentration: { 'hero-slot-1': { effect_id: 'old-concentration', spell_id: 'bless', source_actor: 'hero-slot-1' } },
        active_effects: [{ effect_id: 'old-concentration', spell_id: 'bless', source_actor: 'hero-slot-1' }],
      } : {}),
      resources: {
        'hero-slot-1': { spell_slots_2: { current: 2, max: 2 } },
        'hero-slot-2': { spell_slots_2: { current: 2, max: 2 }, spell_slots_3: { current: 2, max: 2 } },
      },
      combat: combatActive
        ? {
          active: true, round: 1, active_index: 0,
          initiative: [{ actor_id: 'hero-slot-2', total: 30 }, { actor_id: 'foe', total: 20 }, { actor_id: 'scout', total: 10 }],
          action_economy: actionEconomy,
        }
        : { active: false, round: 0, active_index: 0, initiative: [], action_economy: {} },
    },
  }
}

function assertStatus(result, status = 200) {
  assert.equal(result.status, status, JSON.stringify({ code: result.body?.code, error: result.body?.error }))
  return result.body
}

async function harness(t, code, state) {
  const storage = mkdtempSync(join(tmpdir(), `skazanie-${code.toLowerCase()}-`))
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  let child = null
  let logs = ''
  const request = async (path, { cookie = '', method = 'GET', body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const launch = async () => {
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: process.cwd(), env: { ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
        ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: `${code}-setup`, COOKIE_SECURE: 'false', NODE_ENV: 'test', GAME_ENGINE_MODE: 'enforce' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-4_000) })
    child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-4_000) })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode != null || child.signalCode != null) throw new Error(`сервер завершился: ${logs}`)
      try { if ((await fetch(`${baseUrl}/api/health`)).ok) return } catch { /* listener ещё запускается */ }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`сервер не запустился: ${logs}`)
  }
  const stop = async () => {
    if (!child || child.exitCode != null || child.signalCode != null) return
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`тестовый сервер не завершился: ${logs}`)), 5_000)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
      child.kill()
    })
  }
  const command = (cookie, idempotencyKey, commandBody) => request(`/api/campaigns/${code}/commands`, {
    method: 'POST', cookie, body: { idempotency_key: idempotencyKey, command: commandBody },
  })
  const room = (cookie) => request(`/api/rooms/${code}`, { cookie })
  t.after(async () => { await stop(); rmSync(storage, { recursive: true, force: true }) })
  await launch()
  const setupResponse = await request('/api/auth/setup-admin', { method: 'POST', body: {
    name: `${code} admin`, email: `${code.toLowerCase()}-admin@example.test`, password: `${code}-admin-password`, setupToken: `${code}-setup`,
  } })
  assertStatus(setupResponse, 201)
  const adminCookie = setupResponse.cookie
  const registration = await request('/api/auth/register', { method: 'POST', body: {
    name: `${code} owner`, email: `${code.toLowerCase()}-owner@example.test`, password: `${code}-owner-password`,
  } })
  assertStatus(registration, 201)
  const ownerCookie = registration.cookie
  const users = assertStatus(await request('/api/admin/users', { cookie: adminCookie }))
  const owner = users.users.find((candidate) => candidate.email === `${code.toLowerCase()}-owner@example.test`)
  assert.ok(owner)
  assertStatus(await request('/api/campaigns', { method: 'POST', cookie: adminCookie, body: { code, name: code, state } }), 201)
  assertStatus(await request(`/api/admin/users/${owner.id}`, { method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero-slot-1', 'hero-slot-2'] } }))
  return {
    request, command, room, ownerCookie, adminCookie,
    restart: async () => { await stop(); await launch() },
  }
}

test('HTTP Prayer of Healing passes time, immunity, no-spend failure, replay and idempotency', { timeout: runnerTimeout(90_000) }, async (t) => {
  const api = await harness(t, 'PRAYER-SOURCE-API', initialState({ withConcentration: true }))
  const before = assertStatus(await api.room(api.ownerCookie))
  const beforeState = before.state
  const invalid = await api.command(api.ownerCookie, 'prayer-invalid', { command_type: 'CastSpell', actor_id: 'hero-slot-1', spell_id: 'prayer-of-healing', target_id: 'foe', target_ids: ['foe'] })
  assertStatus(invalid, 400)
  assert.equal(Boolean(invalid.body.mechanics?.some((event) => event.event_type === 'TimeAdvanced')), false)
  const afterInvalid = assertStatus(await api.room(api.ownerCookie))
  assert.equal(afterInvalid.state.mechanics.resources['hero-slot-1'].spell_slots_2.current, beforeState.mechanics.resources['hero-slot-1'].spell_slots_2.current)
  assert.equal(afterInvalid.state.mechanics.world_time.elapsed_minutes, beforeState.mechanics.world_time.elapsed_minutes)
  assert.ok(afterInvalid.state.mechanics.concentration['hero-slot-1'])
  const first = assertStatus(await api.command(api.ownerCookie, 'prayer-once', {
    command_type: 'CastSpell', actor_id: 'hero-slot-1', spell_id: 'prayer-of-healing', target_id: 'ally', target_ids: ['ally', 'undead'], slot_level: 2,
  }))
  assert.ok(first.mechanics.some((event) => event.event_type === 'TimeAdvanced' && event.payload.elapsed_minutes === 10))
  const healing = first.mechanics.filter((event) => event.event_type === 'HealingApplied')
  assert.equal(healing.length, 1)
  assert.equal(healing[0].target_ids[0], 'ally')
  const endedConcentration = first.mechanics.filter((event) => event.event_type === 'ConcentrationEnded' && event.payload.reason === 'long-cast-started')
  assert.equal(endedConcentration.length, 1)
  assert.ok(first.mechanics.findIndex((event) => event.event_type === 'ConcentrationEnded' && event.payload.reason === 'long-cast-started')
    < first.mechanics.findIndex((event) => event.event_type === 'TimeAdvanced'))
  assert.equal(first.authoritative_state.mechanics.resources['hero-slot-1'].spell_slots_2.current, 1)
  assert.equal(first.authoritative_state.mechanics.world_time.elapsed_minutes, 10)
  assert.equal(first.authoritative_state.mechanics.concentration['hero-slot-1'], undefined)
  assert.equal(first.authoritative_state.mechanics.active_effects?.some((effect) => effect.effect_id === 'old-concentration'), false)
  const replay = assertStatus(await api.command(api.ownerCookie, 'prayer-once', {
    command_type: 'CastSpell', actor_id: 'hero-slot-1', spell_id: 'prayer-of-healing', target_id: 'ally', target_ids: ['ally', 'undead'], slot_level: 2,
  }))
  assert.equal(replay.idempotent_replay, true)
  assert.equal(replay.authoritative_state.mechanics.resources['hero-slot-1'].spell_slots_2.current, 1)
  assert.equal(replay.mechanics.filter((event) => event.event_type === 'ConcentrationEnded' && event.payload.reason === 'long-cast-started').length, 1)
  await api.restart()
  const restored = assertStatus(await api.room(api.ownerCookie))
  assert.equal(restored.state.mechanics.world_time.elapsed_minutes, 10)
  assert.equal(restored.state.mechanics.resources['hero-slot-1'].spell_slots_2.current, 1)
  assert.equal(restored.state.mechanics.concentration['hero-slot-1'], undefined)
})

test('HTTP Spray of Cards handles cone saves, target-turn blindness expiry, no-spend failure, replay and idempotency', { timeout: runnerTimeout(90_000) }, async (t) => {
  const api = await harness(t, 'SPRAY-SOURCE-API', initialState({ combatActive: true }))
  const before = assertStatus(await api.room(api.ownerCookie))
  const invalid = await api.command(api.ownerCookie, 'spray-invalid', { command_type: 'CastSpell', actor_id: 'hero-slot-2', spell_id: 'spray-of-cards', to: { x: 10, y: 1 }, slot_level: 3 })
  assertStatus(invalid, 400)
  assert.equal(Boolean(invalid.body.mechanics?.some((event) => event.event_type === 'ResourceSpent')), false)
  const afterInvalid = assertStatus(await api.room(api.ownerCookie))
  assert.equal(afterInvalid.state.mechanics.resources['hero-slot-2'].spell_slots_3.current, before.state.mechanics.resources['hero-slot-2'].spell_slots_3.current)
  const command = { command_type: 'CastSpell', actor_id: 'hero-slot-2', spell_id: 'spray-of-cards', to: { x: 4, y: 1 }, slot_level: 3 }
  const first = assertStatus(await api.command(api.ownerCookie, 'spray-once', command))
  const saves = first.mechanics.filter((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(saves.length, 2)
  assert.equal(saves.find((event) => event.target_ids[0] === 'foe').payload.saved, false)
  assert.equal(saves.find((event) => event.target_ids[0] === 'scout').payload.saved, true)
  assert.ok(first.mechanics.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'blinded' && event.payload.duration === 'until-own-turn-end'))
  assert.equal(first.mechanics.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'blinded' && event.target_ids[0] === 'scout'), false)
  assert.equal(first.authoritative_state.mechanics.resources['hero-slot-2'].spell_slots_3.current, 1)
  const replay = assertStatus(await api.command(api.ownerCookie, 'spray-once', command))
  assert.equal(replay.idempotent_replay, true)
  const afterCaster = assertStatus(await api.command(api.ownerCookie, 'spray-end-caster', { command_type: 'EndTurn', actor_id: 'hero-slot-2' }))
  const targetEnd = afterCaster.mechanics.findIndex((event) => event.event_type === 'TurnEnded' && event.actor_id === 'foe')
  assert.ok(targetEnd >= 0, 'сервер должен завершить ход цели после хода заклинателя')
  assert.equal(afterCaster.authoritative_state.mechanics.conditions.foe.some((condition) => condition.id === 'blinded'), false, 'ослепление снимается в конце хода цели')
  await api.restart()
  const restored = assertStatus(await api.room(api.ownerCookie))
  assert.equal(restored.state.mechanics.conditions.foe.some((condition) => condition.id === 'blinded'), false)
  assert.equal(restored.state.mechanics.resources['hero-slot-2'].spell_slots_3.current, 1)
})

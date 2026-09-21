import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { materializeCatalogItem } from '../server/item-catalog.mjs'

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
    if (child.exitCode != null) throw new Error(`Test server exited with ${child.exitCode}\n${log()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return response.json()
    } catch { /* listener is still starting */ }
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
  try { json = text ? JSON.parse(text) : null } catch { /* assertion reports the raw body */ }
  return { response, status: response.status, body: json, text }
}

function sessionCookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

function assertStatus(result, expected, log) {
  assert.equal(result.status, expected, `${result.text.slice(0, 2000)}\n${log().slice(-2000)}`)
  assert.ok(result.body && typeof result.body === 'object', `Expected JSON, received: ${result.text}`)
}

async function command(baseUrl, campaignCode, cookie, idempotencyKey, value) {
  return request(baseUrl, `/api/campaigns/${campaignCode}/commands`, {
    method: 'POST',
    cookie,
    body: {
      idempotency_key: idempotencyKey,
      message: `HTTP component integration: ${value.command_type}`,
      command: value,
    },
  })
}

function cells() {
  return Array.from({ length: 30 }, (_, index) => ({
    x: index % 10,
    y: Math.floor(index / 10),
    type: 'floor',
    revealed: true,
  }))
}

function campaignState(code, inventory) {
  return {
    sessionCode: code,
    campaign: `Компоненты ${code}`,
    partyName: 'HTTP component party',
    partyMemberIds: ['hero', 'ally'],
    activePlayerId: 'hero',
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    players: [
      {
        id: 'hero', name: 'Component player', character: 'Маг', characterClass: 'wizard', level: 5,
        hp: 60, maxHp: 60, armor: 14, speed: 30, proficiency: 3,
        abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 12, cha: 10 },
        inventory,
        knownSpellIds: ['chromatic-orb', 'fireball'],
        preparedSpellIds: ['chromatic-orb', 'fireball'],
        x: 1, y: 1,
      },
      {
        id: 'ally', name: 'Observer ally', character: 'Воин', characterClass: 'fighter', level: 1,
        hp: 20, maxHp: 20, armor: 16, speed: 30, proficiency: 2,
        abilities: { str: 16, dex: 12, con: 14, int: 8, wis: 10, cha: 10 },
        inventory: [], x: 1, y: 0,
        knownSpellIds: [], preparedSpellIds: [],
      },
    ],
    enemies: [{
      id: 'enemy', name: 'Цель', hp: 100, maxHp: 100, armor: 12, speed: 30,
      attackBonus: 0, damageDice: 4, damageBonus: 0,
      abilities: { str: 10, dex: 10, con: 10, int: 8, wis: 8, cha: 8 },
      x: 3, y: 1, alive: true,
    }],
    scene: { title: 'Полигон компонентов', location: 'components-api', turn: 1, cells: cells() },
    mechanics: {
      resources: {
        hero: {
          spell_slots_1: { current: 1, max: 1 },
          spell_slots_3: { current: 1, max: 1 },
        },
      },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'ally', total: 15 }, { actor_id: 'enemy', total: 10 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          ally: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
    engine_mode: 'enforce',
  }
}

function restorationCampaignState(inventory) {
  const state = campaignState('COMPONENTS-RESTORATION', inventory)
  state.players[0] = {
    ...state.players[0],
    character: 'Жрец',
    characterClass: 'cleric',
    level: 12,
    abilities: { ...state.players[0].abilities, wis: 18 },
    knownSpellIds: ['greater-restoration'],
    preparedSpellIds: ['greater-restoration'],
  }
  state.mechanics.conditions = { ally: [{ id: 'petrified', effect_id: 'petrified:api' }] }
  state.mechanics.resources = { hero: { spell_slots_5: { current: 1, max: 1 } } }
  return state
}

function event(result, type) {
  return (result.body?.mechanics ?? []).find((candidate) => candidate.event_type === type)
}

function stateInventory(result) {
  return result.body.authoritative_state.players.find((candidate) => candidate.id === 'hero').inventory
}

test('HTTP компоненты: расходуемые и нерасходуемые требования переживают restart/idempotency', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-spell-components-api-'))
  const setupToken = 'spell-components-api-setup'
  let logs = ''
  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  let child = startServer({ port, storage, setupToken, appendLog: (chunk) => { logs += chunk } })
  const log = () => logs
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })
  await waitForHealth(baseUrl, child, log)

  const setup = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Компонентный мастер', email: 'admin@spell-components-api.test', password: 'spell-components-admin-password', setupToken,
  } })
  assertStatus(setup, 201, log)
  const adminCookie = sessionCookie(setup)
  const player = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Обычный игрок', email: 'player@spell-components-api.test', password: 'spell-components-player-password',
  } })
  assertStatus(player, 201, log)
  const playerCookie = sessionCookie(player)
  const observer = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Наблюдатель', email: 'observer@spell-components-api.test', password: 'spell-components-observer-password',
  } })
  assertStatus(observer, 201, log)
  const observerCookie = sessionCookie(observer)

  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  assertStatus(users, 200, log)
  const playerUser = users.body.users.find((candidate) => candidate.email === 'player@spell-components-api.test')
  const observerUser = users.body.users.find((candidate) => candidate.email === 'observer@spell-components-api.test')
  assert.ok(playerUser && observerUser)
  for (const [userId, heroIds] of [[playerUser.id, ['hero']], [observerUser.id, ['ally']]]) {
    const assigned = await request(baseUrl, `/api/admin/users/${userId}`, { method: 'PATCH', cookie: adminCookie, body: { heroIds } })
    assertStatus(assigned, 200, log)
  }

  const pouch = materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'component-pouch', quantity: 1 })
  const diamond = materializeCatalogItem('srd_5_2_1:diamond-50gp', { id: 'diamond-50gp', quantity: 1 })
  const missingCreated = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie,
    body: { code: 'COMPONENTS-MISSING', name: 'Компоненты без алмаза', state: campaignState('COMPONENTS-MISSING', [pouch]) },
  })
  assertStatus(missingCreated, 201, log)
  const diamondCreated = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie,
    body: { code: 'COMPONENTS-DIAMOND', name: 'Компоненты с алмазом', state: campaignState('COMPONENTS-DIAMOND', [pouch, diamond]) },
  })
  assertStatus(diamondCreated, 201, log)
  const diamondDust = materializeCatalogItem('srd_5_2_1:material-diamond-dust-100gp', { id: 'diamond-dust-100gp', quantity: 2 })
  const mace = { ...materializeCatalogItem('srd_5_2_1:mace', { id: 'cleric-mace', quantity: 1 }), equipped: true }
  const shield = { ...materializeCatalogItem('srd_5_2_1:shield', { id: 'cleric-shield', quantity: 1 }), equipped: true }
  const restorationCreated = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie,
    body: { code: 'COMPONENTS-RESTORATION', name: 'Расходуемые компоненты', state: restorationCampaignState([diamondDust, mace, shield]) },
  })
  assertStatus(restorationCreated, 201, log)

  const missingRoom = await request(baseUrl, '/api/rooms/COMPONENTS-MISSING', { cookie: playerCookie })
  assertStatus(missingRoom, 200, log)
  const missingOrb = missingRoom.body.state.players.find((candidate) => candidate.id === 'hero').combatSpells.find((spell) => spell.id === 'chromatic-orb')
  assert.equal(missingOrb.componentAvailability.available, false)
  assert.equal(missingOrb.componentAvailability.code, 'SPELL_MATERIAL_COMPONENT_REQUIRED')
  const observerRoom = await request(baseUrl, '/api/rooms/COMPONENTS-MISSING', { cookie: observerCookie })
  assertStatus(observerRoom, 200, log)
  const publicHero = observerRoom.body.state.players.find((candidate) => candidate.id === 'hero')
  assert.equal(publicHero.combatSpells.some((spell) => Object.hasOwn(spell, 'componentAvailability')), false)

  const missingBefore = missingRoom.body.state.state_version
  const forgedOrb = await command(baseUrl, 'COMPONENTS-MISSING', playerCookie, 'missing-orb-forged', {
    command_type: 'CastSpell', actor_id: 'hero', spell_id: 'chromatic-orb', target_id: 'enemy', spell_option: 'fire',
    components: { material: { costGp: 0, kind: 'diamond' } },
    componentAvailability: { available: true, code: 'FORGED' },
  })
  assertStatus(forgedOrb, 400, log)
  assert.equal(forgedOrb.body.code, 'SPELL_MATERIAL_COMPONENT_REQUIRED')
  const missingAfterReject = await request(baseUrl, '/api/rooms/COMPONENTS-MISSING', { cookie: playerCookie })
  assertStatus(missingAfterReject, 200, log)
  assert.equal(missingAfterReject.body.state.state_version, missingBefore)

  const fireball = await command(baseUrl, 'COMPONENTS-MISSING', playerCookie, 'pouch-fireball', {
    command_type: 'CastSpell', actor_id: 'hero', spell_id: 'fireball', to: { x: 3, y: 1 },
  })
  assertStatus(fireball, 200, log)
  assert.ok(event(fireball, 'SpellCast'))
  assert.equal(fireball.body.authoritative_state.mechanics.resources.hero.spell_slots_3.current, 0)
  assert.equal((fireball.body.mechanics ?? []).some((candidate) => candidate.event_type === 'ItemConsumed'), false)
  assert.equal(stateInventory(fireball).find((item) => item.id === 'component-pouch')?.quantity, 1)

  const diamondRoom = await request(baseUrl, '/api/rooms/COMPONENTS-DIAMOND', { cookie: playerCookie })
  assertStatus(diamondRoom, 200, log)
  const diamondOrb = diamondRoom.body.state.players.find((candidate) => candidate.id === 'hero').combatSpells.find((spell) => spell.id === 'chromatic-orb')
  assert.equal(diamondOrb.componentAvailability.available, true)
  const orb = await command(baseUrl, 'COMPONENTS-DIAMOND', playerCookie, 'diamond-orb', {
    command_type: 'CastSpell', actor_id: 'hero', spell_id: 'chromatic-orb', target_id: 'enemy', spell_option: 'fire',
  })
  assertStatus(orb, 200, log)
  assert.ok(event(orb, 'SpellCast'))
  assert.equal(orb.body.authoritative_state.mechanics.resources.hero.spell_slots_1.current, 0)
  assert.equal((orb.body.mechanics ?? []).some((candidate) => candidate.event_type === 'ItemConsumed'), false)
  assert.equal(stateInventory(orb).find((item) => item.id === 'diamond-50gp')?.quantity, 1)

  const duplicate = await command(baseUrl, 'COMPONENTS-DIAMOND', playerCookie, 'diamond-orb', {
    command_type: 'CastSpell', actor_id: 'hero', spell_id: 'chromatic-orb', target_id: 'enemy', spell_option: 'fire',
  })
  assertStatus(duplicate, 200, log)
  assert.equal(duplicate.body.idempotent_replay, true)
  assert.equal(duplicate.body.authoritative_state.state_version, orb.body.authoritative_state.state_version)
  assert.equal(stateInventory(duplicate).find((item) => item.id === 'diamond-50gp')?.quantity, 1)

  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, setupToken, appendLog: (chunk) => { logs += chunk } })
  await waitForHealth(baseUrl, child, log)
  const afterRestart = await command(baseUrl, 'COMPONENTS-DIAMOND', playerCookie, 'diamond-orb', {
    command_type: 'CastSpell', actor_id: 'hero', spell_id: 'chromatic-orb', target_id: 'enemy', spell_option: 'fire',
  })
  assertStatus(afterRestart, 200, log)
  assert.equal(afterRestart.body.idempotent_replay, true)
  assert.equal(afterRestart.body.authoritative_state.state_version, orb.body.authoritative_state.state_version)
  assert.equal(stateInventory(afterRestart).find((item) => item.id === 'diamond-50gp')?.quantity, 1)

  const restorationRoom = await request(baseUrl, '/api/rooms/COMPONENTS-RESTORATION', { cookie: playerCookie })
  assertStatus(restorationRoom, 200, log)
  const restorationSpell = restorationRoom.body.state.players.find((candidate) => candidate.id === 'hero').combatSpells.find((spell) => spell.id === 'greater-restoration')
  assert.equal(restorationSpell.componentAvailability.code, 'SPELL_MATERIAL_HAND_REQUIRED')
  const stowCommand = { command_type: 'EquipItem', actor_id: 'hero', item_id: 'cleric-mace', equipped: false }
  const stowed = await command(baseUrl, 'COMPONENTS-RESTORATION', playerCookie, 'stow-mace', stowCommand)
  assertStatus(stowed, 200, log)
  assert.equal(event(stowed, 'ItemUnequipped')?.payload.combat_action, 'object_interaction')
  assert.equal(stowed.body.authoritative_state.mechanics.combat.action_economy.hero.action, true)
  assert.equal(stowed.body.authoritative_state.mechanics.combat.action_economy.hero.object_interaction, false)
  assert.equal(stateInventory(stowed).find((item) => item.id === 'cleric-shield')?.equipped, true)
  const stowDuplicate = await command(baseUrl, 'COMPONENTS-RESTORATION', playerCookie, 'stow-mace', stowCommand)
  assertStatus(stowDuplicate, 200, log)
  assert.equal(stowDuplicate.body.idempotent_replay, true)
  assert.equal(stowDuplicate.body.authoritative_state.state_version, stowed.body.authoritative_state.state_version)
  const freeHandRoom = await request(baseUrl, '/api/rooms/COMPONENTS-RESTORATION', { cookie: playerCookie })
  assert.equal(freeHandRoom.body.state.players.find((candidate) => candidate.id === 'hero').combatSpells.find((spell) => spell.id === 'greater-restoration').componentAvailability.available, true)
  const restoration = await command(baseUrl, 'COMPONENTS-RESTORATION', playerCookie, 'greater-restoration', {
    command_type: 'CastSpell', actor_id: 'hero', spell_id: 'greater-restoration', target_id: 'ally', spell_option: 'petrified',
  })
  assertStatus(restoration, 200, log)
  assert.ok(event(restoration, 'SpellCast'))
  const consumed = (restoration.body.mechanics ?? []).find((candidate) => candidate.event_type === 'ItemConsumed')
  assert.equal(consumed?.payload.quantity, 1)
  assert.equal(consumed?.payload.item_id, 'diamond-dust-100gp')
  assert.equal(restoration.body.authoritative_state.mechanics.resources.hero.spell_slots_5.current, 0)
  assert.equal(stateInventory(restoration).find((item) => item.id === 'diamond-dust-100gp')?.quantity, 1)
  assert.equal(restoration.body.authoritative_state.mechanics.conditions.ally?.some((condition) => condition.id === 'petrified'), false)

  const restorationDuplicate = await command(baseUrl, 'COMPONENTS-RESTORATION', playerCookie, 'greater-restoration', {
    command_type: 'CastSpell', actor_id: 'hero', spell_id: 'greater-restoration', target_id: 'ally', spell_option: 'petrified',
  })
  assertStatus(restorationDuplicate, 200, log)
  assert.equal(restorationDuplicate.body.idempotent_replay, true)
  assert.equal(restorationDuplicate.body.authoritative_state.state_version, restoration.body.authoritative_state.state_version)
  assert.equal(stateInventory(restorationDuplicate).find((item) => item.id === 'diamond-dust-100gp')?.quantity, 1)

  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, setupToken, appendLog: (chunk) => { logs += chunk } })
  await waitForHealth(baseUrl, child, log)
  const restorationAfterRestart = await command(baseUrl, 'COMPONENTS-RESTORATION', playerCookie, 'greater-restoration', {
    command_type: 'CastSpell', actor_id: 'hero', spell_id: 'greater-restoration', target_id: 'ally', spell_option: 'petrified',
  })
  assertStatus(restorationAfterRestart, 200, log)
  assert.equal(restorationAfterRestart.body.idempotent_replay, true)
  assert.equal(restorationAfterRestart.body.authoritative_state.state_version, restoration.body.authoritative_state.state_version)
  assert.equal(stateInventory(restorationAfterRestart).find((item) => item.id === 'diamond-dust-100gp')?.quantity, 1)
  const stowAfterRestart = await command(baseUrl, 'COMPONENTS-RESTORATION', playerCookie, 'stow-mace', stowCommand)
  assertStatus(stowAfterRestart, 200, log)
  assert.equal(stowAfterRestart.body.idempotent_replay, true)
  const finalRoom = await request(baseUrl, '/api/rooms/COMPONENTS-RESTORATION', { cookie: playerCookie })
  assert.equal(finalRoom.body.state.mechanics.combat.action_economy.hero.action, false)
  assert.equal(finalRoom.body.state.mechanics.combat.action_economy.hero.object_interaction, false)
})

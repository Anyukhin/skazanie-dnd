import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

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
      ADMIN_SETUP_TOKEN: 'item-effects-api-setup',
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

const sessionCookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

function fallenHero(id, x, y) {
  return {
    id,
    character: id,
    hp: 0,
    maxHp: 12,
    armor: 12,
    x,
    y,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    inventory: [],
  }
}

function initialState() {
  return {
    state_version: 0,
    sessionCode: 'ITEM-EFFECTS-API',
    campaign: 'Предметные эффекты',
    activePlayerId: 'medic',
    partyMemberIds: ['medic', 'ally-a', 'ally-b', 'ally-c'],
    players: [
      {
        id: 'medic',
        character: 'Лекарь',
        characterClass: 'cleric',
        level: 1,
        hp: 18,
        maxHp: 18,
        armor: 15,
        x: 0,
        y: 0,
        abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 16, cha: 10 },
        inventory: [
          {
            id: 'kit-idempotent',
            catalog_id: 'srd_5_2_1:healers-kit',
            name: 'Набор лекаря',
            type: 'gear',
            quantity: 1,
            charges: { current: 10, max: 10 },
          },
          {
            id: 'kit-last-charge',
            catalog_id: 'srd_5_2_1:healers-kit',
            name: 'Почти пустой набор лекаря',
            type: 'gear',
            quantity: 1,
            charges: { current: 1, max: 10 },
          },
          materializeCatalogItem('srd_5_2_1:ring-of-protection', {
            id: 'ring-protection',
            quantity: 1,
          }),
          materializeCatalogItem('srd_5_2_1:flame-tongue-longsword', {
            id: 'flame-tongue',
            quantity: 1,
          }),
        ],
      },
      fallenHero('ally-a', 1, 0),
      fallenHero('ally-b', 0, 1),
      fallenHero('ally-c', 1, 1),
    ],
    scene: {
      title: 'Лазарет',
      location: 'Лазарет',
      turn: 1,
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'floor', revealed: true },
        { x: 0, y: 1, type: 'floor', revealed: true },
        { x: 1, y: 1, type: 'floor', revealed: true },
      ],
    },
    mechanics: {
      positions: {
        medic: { x: 0, y: 0 },
        'ally-a': { x: 1, y: 0 },
        'ally-b': { x: 0, y: 1 },
        'ally-c': { x: 1, y: 1 },
      },
      conditions: {
        'ally-a': [{ id: 'unconscious' }],
        'ally-b': [{ id: 'unconscious' }],
        'ally-c': [{ id: 'unconscious' }],
      },
      death: {
        saving_throws: {
          'ally-a': { successes: 0, failures: 0, stable: false },
          'ally-b': { successes: 0, failures: 0, stable: false },
          'ally-c': { successes: 0, failures: 0, stable: false },
        },
        heroes: {},
        campaign_status: 'active',
      },
      combat: { active: false },
    },
  }
}

function specializedItemState(sessionCode, catalogId, itemId) {
  const weapon = {
    id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true,
    combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 },
  }
  return {
    state_version: 0,
    sessionCode,
    campaign_id: sessionCode,
    campaign: 'Специализированные предметы',
    activePlayerId: 'specialist',
    partyMemberIds: ['specialist'],
    players: [{
      id: 'specialist', character: 'Испытатель', characterClass: 'fighter', level: 3,
      hp: 30, maxHp: 30, armor: 15, speed: 30, proficiency: 2,
      abilities: { str: 16, dex: 16, con: 14, int: 10, wis: 10, cha: 10 },
      x: 0, y: 0,
      inventory: [weapon, materializeCatalogItem(catalogId, { id: itemId, quantity: 1 })],
    }],
    enemies: [{
      id: 'foe', name: 'Противник', hp: 20, maxHp: 20, armor: 12, speed: 30, alive: true,
      creature_type: 'beast', abilities: { str: 12, dex: 10, con: 12, int: 6, wis: 10, cha: 6 },
      x: 3, y: 0,
    }],
    scene: {
      title: 'Полигон', location: 'Полигон', turn: 1,
      cells: Array.from({ length: 12 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })),
    },
    mechanics: {
      positions: { specialist: { x: 0, y: 0 }, foe: { x: 3, y: 0 } },
      conditions: {},
      death: { saving_throws: {}, heroes: {}, campaign_status: 'active' },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'specialist', total: 20 }, { actor_id: 'foe', total: 5 }],
        action_economy: {
          specialist: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  }
}

function itemCommand(key, itemId, targetId, expectedStateVersion) {
  const command = {
    command_type: 'UseItem',
    actor_id: 'medic',
    item_id: itemId,
    target_id: targetId,
    ...(expectedStateVersion == null ? {} : { expected_state_version: expectedStateVersion }),
  }
  return {
    key,
    body: {
      idempotency_key: key,
      command,
    },
  }
}

function lifecycleCommand(key, commandType, fields = {}) {
  return {
    key,
    body: {
      idempotency_key: key,
      command: {
        command_type: commandType,
        actor_id: 'medic',
        item_id: 'ring-protection',
        ...fields,
      },
    },
  }
}

test('HTTP item commands enforce ACL, semantic idempotency, stale writes and a single last charge', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-item-effects-api-'))
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
      email: 'gm@item-effects.test',
      password: 'secure-admin-password',
      setupToken: 'item-effects-api-setup',
    },
  })
  assert.equal(admin.status, 201, `${admin.text}\n${logs}`)
  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Owner', email: 'owner@item-effects.test', password: 'secure-owner-password' },
  })
  const foreign = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Foreign', email: 'foreign@item-effects.test', password: 'secure-foreign-password' },
  })
  assert.equal(owner.status, 201, `${owner.text}\n${logs}`)
  assert.equal(foreign.status, 201, `${foreign.text}\n${logs}`)
  const adminCookie = sessionCookie(admin)
  const ownerCookie = sessionCookie(owner)
  const foreignCookie = sessionCookie(foreign)

  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const ownerUser = users.body.users.find((candidate) => candidate.email === 'owner@item-effects.test')
  const ownership = await request(baseUrl, `/api/admin/users/${ownerUser.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { heroIds: ['medic'] },
  })
  assert.equal(ownership.status, 200, `${ownership.text}\n${logs}`)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      code: 'ITEM-EFFECTS-API',
      name: 'Предметные эффекты',
      state: initialState(),
    },
  })
  assert.equal(created.status, 201, `${created.text}\n${logs}`)

  const firstCommand = itemCommand('item-same-command', 'kit-idempotent', 'ally-a')
  const forbidden = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: foreignCookie,
    key: 'item-forbidden',
    body: { ...firstCommand.body, idempotency_key: 'item-forbidden' },
  })
  assert.equal(forbidden.status, 403, `${forbidden.text}\n${logs}`)

  const forgedActivation = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    key: 'flame-forged',
    body: {
      idempotency_key: 'flame-forged',
      command: {
        command_type: 'ActivateItem', actor_id: 'medic', item_id: 'flame-tongue', activated: true,
        passive_effects: [{ damage: '999d999' }],
      },
    },
  })
  assert.equal(forgedActivation.status, 400, `${forgedActivation.text}\n${logs}`)
  assert.equal(forgedActivation.body.code, 'ITEM_COMMAND_UNKNOWN_FIELD')

  const flameEquip = lifecycleCommand('flame-equip', 'EquipItem', { item_id: 'flame-tongue', equipped: true })
  const flameEquipped = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST', cookie: ownerCookie, ...flameEquip,
  })
  assert.equal(flameEquipped.status, 200, `${flameEquipped.text}\n${logs}`)
  const flameAttune = lifecycleCommand('flame-attune', 'AttuneItem', { item_id: 'flame-tongue', attuned: true })
  const flameAttuned = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST', cookie: ownerCookie, ...flameAttune,
  })
  assert.equal(flameAttuned.status, 200, `${flameAttuned.text}\n${logs}`)

  const flameActivation = lifecycleCommand('flame-activate', 'ActivateItem', { item_id: 'flame-tongue', activated: true })
  const foreignActivation = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST', cookie: foreignCookie, key: 'flame-foreign', body: { ...flameActivation.body, idempotency_key: 'flame-foreign' },
  })
  assert.equal(foreignActivation.status, 403, `${foreignActivation.text}\n${logs}`)
  const flameActivated = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST', cookie: ownerCookie, ...flameActivation,
  })
  assert.equal(flameActivated.status, 200, `${flameActivated.text}\n${logs}`)
  assert.deepEqual(flameActivated.body.mechanics.map((event) => event.event_type), ['MagicItemActivationChanged'])
  assert.equal(flameActivated.body.mechanics[0].event_schema_version, 1)
  assert.equal(flameActivated.body.mechanics[0].payload.activated, true, JSON.stringify(flameActivated.body.mechanics[0]))
  assert.equal(flameActivated.body.mechanics[0].payload.request_fingerprint.length, 64)
  const projectedFlame = flameActivated.body.authoritative_state.players[0].inventory.find((item) => item.id === 'flame-tongue')
  assert.equal(projectedFlame.activated, true, JSON.stringify(projectedFlame))
  assert.equal(projectedFlame.capabilities.activated, true)
  assert.equal(projectedFlame.capabilities.activation.action_type, 'bonus_action')

  const flameReplay = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST', cookie: ownerCookie, ...flameActivation,
  })
  assert.equal(flameReplay.status, 200, `${flameReplay.text}\n${logs}`)
  assert.equal(flameReplay.body.idempotent_replay, true)
  const flameCollision = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    key: 'flame-activate',
    body: { idempotency_key: 'flame-activate', command: { command_type: 'ActivateItem', actor_id: 'medic', item_id: 'flame-tongue', activated: false } },
  })
  assert.equal(flameCollision.status, 409, `${flameCollision.text}\n${logs}`)
  assert.equal(flameCollision.body.code, 'IDEMPOTENCY_CONFLICT')

  const equipCommand = lifecycleCommand('ring-equip', 'EquipItem', { equipped: true })
  const equipped = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...equipCommand,
  })
  assert.equal(equipped.status, 200, `${equipped.text}\n${logs}`)
  assert.deepEqual(equipped.body.mechanics.map((event) => event.event_type), ['ItemEquipped'])
  const equippedRing = equipped.body.authoritative_state.players[0].inventory
    .find((item) => item.id === 'ring-protection')
  assert.equal(equippedRing.equipped, true)
  assert.equal(equippedRing.capabilities.requires_attunement, true)
  assert.equal(equipped.body.authoritative_state.players[0].characterSheet.armor_class.item_effect_bonus, 0)

  const equipReplay = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...equipCommand,
  })
  assert.equal(equipReplay.status, 200, `${equipReplay.text}\n${logs}`)
  assert.equal(equipReplay.body.idempotent_replay, true)

  const attuneCommand = lifecycleCommand('ring-attune', 'AttuneItem', { attuned: true })
  const attuned = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...attuneCommand,
  })
  assert.equal(attuned.status, 200, `${attuned.text}\n${logs}`)
  assert.deepEqual(attuned.body.mechanics.map((event) => event.event_type), ['ItemAttunementChanged'])
  const attunedMedic = attuned.body.authoritative_state.players[0]
  const attunedRing = attunedMedic.inventory.find((item) => item.id === 'ring-protection')
  assert.equal(attunedRing.attuned_to, 'medic')
  assert.equal(attunedRing.passive_effects[0].saving_throw_bonus, 1)
  assert.equal(attunedMedic.characterSheet.armor_class.item_effect_bonus, 1)
  assert.equal(attunedMedic.armor, 12)

  const attuneReplay = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...attuneCommand,
  })
  assert.equal(attuneReplay.status, 200, `${attuneReplay.text}\n${logs}`)
  assert.equal(attuneReplay.body.idempotent_replay, true)

  const first = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...firstCommand,
  })
  assert.equal(first.status, 200, `${first.text}\n${logs}`)
  assert.deepEqual(first.body.mechanics.map((event) => event.event_type), [
    'ItemUsed',
    'HeroStabilized',
    'ItemChargesSpent',
  ])
  const projectedKit = first.body.authoritative_state.players[0].inventory
    .find((item) => item.id === 'kit-idempotent')
  assert.deepEqual(projectedKit.capabilities.charges, { current: 9, max: 10 })

  const duplicate = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...firstCommand,
  })
  assert.equal(duplicate.status, 200, `${duplicate.text}\n${logs}`)
  assert.equal(duplicate.body.idempotent_replay, true)
  assert.deepEqual(
    duplicate.body.authoritative_state.players[0].inventory
      .find((item) => item.id === 'kit-idempotent').capabilities.charges,
    { current: 9, max: 10 },
  )

  const collisionCommand = itemCommand('item-same-command', 'kit-idempotent', 'ally-b')
  const collision = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...collisionCommand,
  })
  assert.equal(collision.status, 409, `${collision.text}\n${logs}`)
  assert.equal(collision.body.code, 'IDEMPOTENCY_CONFLICT')

  const staleCommand = itemCommand('item-stale', 'kit-last-charge', 'ally-b', 0)
  const stale = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...staleCommand,
  })
  assert.equal(stale.status, 409, `${stale.text}\n${logs}`)
  assert.equal(stale.body.code, 'STATE_VERSION_CONFLICT')

  const roomBeforeRace = await request(baseUrl, '/api/rooms/ITEM-EFFECTS-API', { cookie: adminCookie })
  assert.equal(roomBeforeRace.status, 200, `${roomBeforeRace.text}\n${logs}`)
  const version = roomBeforeRace.body.state.state_version
  const raceCommands = [
    itemCommand('item-last-charge-a', 'kit-last-charge', 'ally-b', version),
    itemCommand('item-last-charge-b', 'kit-last-charge', 'ally-c', version),
  ]
  const race = await Promise.all(raceCommands.map((entry) => request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...entry,
  })))
  assert.equal(race.filter((result) => result.status === 200).length, 1, race.map((result) => result.text).join('\n'))
  assert.equal(race.filter((result) => result.status === 409).length, 1, race.map((result) => result.text).join('\n'))

  const roomAfterRace = await request(baseUrl, '/api/rooms/ITEM-EFFECTS-API', { cookie: adminCookie })
  assert.equal(roomAfterRace.status, 200, `${roomAfterRace.text}\n${logs}`)
  const finalState = roomAfterRace.body.state
  const finalKit = finalState.players[0].inventory.find((item) => item.id === 'kit-last-charge')
  assert.deepEqual(finalKit.charges, { current: 0, max: 10 })
  const stableTargets = ['ally-b', 'ally-c']
    .filter((id) => finalState.mechanics.death.saving_throws[id].stable === true)
  assert.equal(stableTargets.length, 1)

  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const durableRoom = await request(baseUrl, '/api/rooms/ITEM-EFFECTS-API', { cookie: adminCookie })
  assert.equal(durableRoom.status, 200, `${durableRoom.text}\n${logs}`)
  const durableState = durableRoom.body.state
  assert.deepEqual(
    durableState.players[0].inventory.find((item) => item.id === 'kit-last-charge').charges,
    { current: 0, max: 10 },
  )
  assert.equal(
    ['ally-b', 'ally-c'].filter((id) => durableState.mechanics.death.saving_throws[id].stable === true).length,
    1,
  )
  const durableMedic = durableState.players.find((player) => player.id === 'medic')
  const durableRing = durableMedic.inventory.find((item) => item.id === 'ring-protection')
  const durableFlame = durableMedic.inventory.find((item) => item.id === 'flame-tongue')
  assert.equal(durableRing.equipped, true)
  assert.equal(durableRing.attuned_to, 'medic')
  assert.equal(durableRing.passive_effects[0].armor_class_bonus, 1)
  assert.equal(durableRing.capabilities.requires_attunement, true)
  assert.equal(durableMedic.characterSheet.armor_class.item_effect_bonus, 1)
  assert.equal(durableMedic.armor, 12)
  assert.equal(durableFlame.equipped, true)
  assert.equal(durableFlame.attuned_to, 'medic')
  assert.equal(durableFlame.activated, true)
  assert.equal(durableFlame.capabilities.activated, true)

  const durableAttuneReplay = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...attuneCommand,
  })
  assert.equal(durableAttuneReplay.status, 200, `${durableAttuneReplay.text}\n${logs}`)
  assert.equal(durableAttuneReplay.body.idempotent_replay, true)

  const durableReplay = await request(baseUrl, '/api/campaigns/ITEM-EFFECTS-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    ...firstCommand,
  })
  assert.equal(durableReplay.status, 200, `${durableReplay.text}\n${logs}`)
  assert.equal(durableReplay.body.idempotent_replay, true)
  assert.deepEqual(
    durableReplay.body.authoritative_state.players[0].inventory
      .find((item) => item.id === 'kit-idempotent').capabilities.charges,
    { current: 9, max: 10 },
  )
})

test('HTTP player item path carries point, mode and weapon inputs with semantic idempotency', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-specialized-items-api-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'GM', email: 'gm@specialized-items.test', password: 'secure-admin-password', setupToken: 'item-effects-api-setup' },
  })
  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Owner', email: 'owner@specialized-items.test', password: 'secure-owner-password' },
  })
  assert.equal(admin.status, 201, `${admin.text}\n${logs}`)
  assert.equal(owner.status, 201, `${owner.text}\n${logs}`)
  const adminCookie = sessionCookie(admin)
  const ownerCookie = sessionCookie(owner)
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const ownerUser = users.body.users.find((candidate) => candidate.email === 'owner@specialized-items.test')
  const ownership = await request(baseUrl, `/api/admin/users/${ownerUser.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['specialist'] },
  })
  assert.equal(ownership.status, 200, `${ownership.text}\n${logs}`)

  const cases = [
    ['ITEM-POINT-API', 'srd_5_2_1:caltrops', 'caltrops'],
    ['ITEM-OIL-API', 'srd_5_2_1:oil-flask', 'oil'],
    ['ITEM-POISON-API', 'srd_5_2_1:poison-basic', 'poison'],
  ]
  for (const [code, catalogId, itemId] of cases) {
    const created = await request(baseUrl, '/api/campaigns', {
      method: 'POST', cookie: adminCookie,
      body: { code, name: code, state: specializedItemState(code, catalogId, itemId) },
    })
    assert.equal(created.status, 201, `${created.text}\n${logs}`)
  }

  const caltropsBody = {
    idempotency_key: 'caltrops-point',
    command: { command_type: 'UseItem', actor_id: 'specialist', item_id: 'caltrops', to: { x: 1, y: 0 } },
  }
  const caltrops = await request(baseUrl, '/api/campaigns/ITEM-POINT-API/commands', {
    method: 'POST', cookie: ownerCookie, key: 'caltrops-point', body: caltropsBody,
  })
  assert.equal(caltrops.status, 200, `${caltrops.text}\n${logs}`)
  assert.ok(caltrops.body.mechanics.some((event) => event.event_type === 'SpellAreaCreated'))
  const caltropsReplay = await request(baseUrl, '/api/campaigns/ITEM-POINT-API/commands', {
    method: 'POST', cookie: ownerCookie, key: 'caltrops-point', body: caltropsBody,
  })
  assert.equal(caltropsReplay.status, 200, `${caltropsReplay.text}\n${logs}`)
  assert.equal(caltropsReplay.body.idempotent_replay, true)
  const caltropsCollision = await request(baseUrl, '/api/campaigns/ITEM-POINT-API/commands', {
    method: 'POST', cookie: ownerCookie, key: 'caltrops-point',
    body: { ...caltropsBody, command: { ...caltropsBody.command, to: { x: 0, y: 1 } } },
  })
  assert.equal(caltropsCollision.status, 409, `${caltropsCollision.text}\n${logs}`)
  assert.equal(caltropsCollision.body.code, 'IDEMPOTENCY_CONFLICT')

  const malformedPoint = await request(baseUrl, '/api/campaigns/ITEM-POINT-API/commands', {
    method: 'POST', cookie: ownerCookie, key: 'caltrops-forged-point',
    body: {
      idempotency_key: 'caltrops-forged-point',
      command: { command_type: 'UseItem', actor_id: 'specialist', item_id: 'caltrops', to: { x: 1, y: 0, radius: 99 } },
    },
  })
  assert.equal(malformedPoint.status, 400, `${malformedPoint.text}\n${logs}`)
  assert.equal(malformedPoint.body.code, 'INVALID_ITEM_POINT')

  const oilBody = {
    idempotency_key: 'oil-spill',
    command: { command_type: 'UseItem', actor_id: 'specialist', item_id: 'oil', use_mode: 'spill', to: { x: 1, y: 0 } },
  }
  const oil = await request(baseUrl, '/api/campaigns/ITEM-OIL-API/commands', {
    method: 'POST', cookie: ownerCookie, key: 'oil-spill', body: oilBody,
  })
  assert.equal(oil.status, 200, `${oil.text}\n${logs}`)
  assert.ok(oil.body.mechanics.some((event) => event.event_type === 'SpellAreaCreated'))

  const poisonBody = {
    idempotency_key: 'poison-weapon',
    command: { command_type: 'UseItem', actor_id: 'specialist', item_id: 'poison', weapon_id: 'sword' },
  }
  const poison = await request(baseUrl, '/api/campaigns/ITEM-POISON-API/commands', {
    method: 'POST', cookie: ownerCookie, key: 'poison-weapon', body: poisonBody,
  })
  assert.equal(poison.status, 200, `${poison.text}\n${logs}`)
  assert.ok(poison.body.mechanics.some((event) => event.event_type === 'ConditionAdded'))
  const poisonCollision = await request(baseUrl, '/api/campaigns/ITEM-POISON-API/commands', {
    method: 'POST', cookie: ownerCookie, key: 'poison-weapon',
    body: { ...poisonBody, command: { ...poisonBody.command, weapon_id: 'forged-weapon' } },
  })
  assert.equal(poisonCollision.status, 409, `${poisonCollision.text}\n${logs}`)
  assert.equal(poisonCollision.body.code, 'IDEMPOTENCY_CONFLICT')
})

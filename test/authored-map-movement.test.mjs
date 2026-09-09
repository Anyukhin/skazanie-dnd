import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runnerTimeout } from './shared-runner-timeout.mjs'
import { authoredLocationMapFor } from '../server/authored-location-maps.mjs'
import { cellAt } from '../server/tactical-map.mjs'

const SESSION = 'AUTHORED-MAP-MOVE'
const SETUP_TOKEN = 'authored-map-movement-setup-token'
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
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Тестовый сервер не завершился')), 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error('Тестовый сервер завершился до health')
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* listener ещё запускается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Тестовый сервер не стал healthy')
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body, key = '' } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : JSON_HEADERS),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(key ? { 'X-Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* assertion reports status */ }
  return { status: response.status, body: parsed, text, response }
}

function sessionCookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0] ?? ''
}

function hero(index) {
  return {
    id: `map-hero-${index}`,
    name: `Игрок ${index}`,
    character: `Герой ${index}`,
    role: 'Воин · ур. 1',
    species: 'Человек',
    background: 'Странник',
    backstory: 'Проверяет, можно ли пройти по королевскому замку.',
    level: 1,
    hp: 30,
    maxHp: 30,
    armor: 18,
    speed: 30,
    proficiency: 2,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    inventory: [],
    online: true,
    attackBonus: 5,
    damageDice: 8,
    damageBonus: 3,
    damageType: 'slashing',
    attackRange: 5,
  }
}

function commandBody(key, actorId, to) {
  return {
    idempotency_key: key,
    message: 'Проверка движения по authored-карте',
    command: { command_type: 'MoveActor', actor_id: actorId, to },
  }
}

function characterDocument(character) {
  const abilities = { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 }
  return {
    schema: 'skazanie.character',
    schema_version: 1,
    character: {
      character,
      name: character,
      role: 'Воин · ур. 1',
      characterClass: 'barbarian',
      species: 'Человек',
      background: 'Солдат',
      level: 1,
      experience: 0,
      abilities,
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.standard-array',
        policyVersion: 1,
        method: 'standard_array',
        baseScores: abilities,
        originBonusProfileId: 'none',
        originBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
        speciesOptionId: 'human',
      },
      baseSpeed: 30,
      hitPointIncreases: [],
      classSkillProficiencies: ['athletics', 'perception'],
      selectedFeatureIds: [],
      knownSpellIds: [],
      preparedSpellIds: [],
    },
  }
}

function statePosition(room, actorId) {
  return room.body.state.players.find((player) => player.id === actorId)
}

test('authored Ares map enforces walls, table occupancy, routes around props, ACL, idempotency and replay', { timeout: runnerTimeout(45_000) }, async (t) => {
  const map = authoredLocationMapFor('astohan-stormberg')
  assert.ok(map, 'для HTTP movement test нужен опубликованный Ares map')
  assert.deepEqual([map.width, map.height], [24, 18])
  assert.equal(cellAt(map, 6, 4)?.passable ?? false, false)
  assert.ok(map.props.some((prop) => prop.id === 'war-table' && prop.footprint.some((cell) => cell.x === 11 && cell.y === 8)))
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-authored-map-movement-'))
  let logs = ''
  let child = null
  let baseUrl = ''
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })

  const launch = async () => {
    const port = await freePort()
    baseUrl = `http://127.0.0.1:${port}`
    child = startServer(port, storage, (chunk) => { logs += chunk })
    await waitForHealth(baseUrl, child)
  }
  await launch()

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Map test admin', email: 'authored-map-admin@example.test', password: 'secure-map-admin-password', setupToken: SETUP_TOKEN },
  })
  assert.equal(admin.status, 201, admin.text)
  const adminCookie = sessionCookie(admin)
  assert.ok(adminCookie)
  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Map owner', email: 'authored-map-owner@example.test', password: 'secure-map-owner-password' },
  })
  const guest = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Map guest', email: 'authored-map-guest@example.test', password: 'secure-map-guest-password' },
  })
  assert.equal(owner.status, 201, owner.text)
  assert.equal(guest.status, 201, guest.text)
  const ownerCookie = sessionCookie(owner)
  const guestCookie = sessionCookie(guest)
  assert.ok(ownerCookie)
  assert.ok(guestCookie)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      code: SESSION,
      name: 'Авторитетное движение по замку',
      bootstrap: { partyName: 'Два картографа', worldTemplateId: 'astohan-plains', players: [hero(1), hero(2)] },
    },
  })
  assert.equal(created.status, 201, created.text)
  assert.equal(created.body.state.scene.map.locationId, 'astohan-stormberg')
  assert.equal(created.body.state.scene.map.tilesetId, 'authored-tactical:astohan-stormberg:v1')
  const initial = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: ownerCookie })
  assert.equal(initial.status, 200, initial.text)
  assert.deepEqual(statePosition(initial, 'map-hero-1') && [statePosition(initial, 'map-hero-1').x, statePosition(initial, 'map-hero-1').y], [9, 9])
  assert.deepEqual(statePosition(initial, 'map-hero-2') && [statePosition(initial, 'map-hero-2').x, statePosition(initial, 'map-hero-2').y], [8, 9])

  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  assert.equal(users.status, 200, users.text)
  const guestUser = users.body.users.find((user) => user.email === 'authored-map-guest@example.test')
  assert.ok(guestUser)
  const invite = await request(baseUrl, `/api/campaigns/${SESSION}/invites`, {
    method: 'POST', cookie: ownerCookie, body: { hero_ids: ['map-hero-2'] },
  })
  assert.equal(invite.status, 201, invite.text)
  const joined = await request(baseUrl, `/api/campaigns/${SESSION}/join`, {
    method: 'POST', cookie: guestCookie, body: { invite_token: invite.body.token },
  })
  assert.equal(joined.status, 200, joined.text)
  assert.deepEqual(joined.body.hero_ids, ['map-hero-2'])

  for (const [index, cookie] of [[1, ownerCookie], [2, guestCookie]]) {
    const imported = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
      method: 'POST', cookie, key: `ares-import-${index}`,
      body: {
        idempotency_key: `ares-import-${index}`,
        message: 'Завершить лист героя для теста карты',
        command: { command_type: 'ImportCharacter', actor_id: `map-hero-${index}`, document: characterDocument(`Герой ${index}`) },
      },
    })
    assert.equal(imported.status, 200, imported.text)
  }

  const wall = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: 'ares-move-wall', body: commandBody('ares-move-wall', 'map-hero-1', { x: 6, y: 4 }),
  })
  assert.equal(wall.status, 400, String(wall.body?.code ?? wall.text.slice(0, 240)))
  assert.match(String(wall.body?.code), /PATH|DESTINATION|MOVE/u)

  const table = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: 'ares-move-table', body: commandBody('ares-move-table', 'map-hero-1', { x: 11, y: 8 }),
  })
  assert.equal(table.status, 400, String(table.body?.code ?? table.text.slice(0, 240)))
  assert.match(String(table.body?.code), /PROP|OCCUP|DESTINATION|PATH|MOVE/u)

  const closedStudy = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: 'ares-closed-study', body: commandBody('ares-closed-study', 'map-hero-1', { x: 5, y: 8 }),
  })
  assert.equal(closedStudy.status, 400, closedStudy.text)
  const approachDoor = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: 'ares-approach-door', body: commandBody('ares-approach-door', 'map-hero-1', { x: 7, y: 8 }),
  })
  assert.equal(approachDoor.status, 200, approachDoor.text)
  const opened = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: 'ares-open-study', body: {
      idempotency_key: 'ares-open-study', message: 'Открыть дверь кабинета',
      command: { command_type: 'OperateDoor', actor_id: 'map-hero-1', door_id: 'ares-west-study', intent: 'open' },
    },
  })
  assert.equal(opened.status, 200, opened.text)
  const enteredStudy = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: 'ares-enter-study', body: commandBody('ares-enter-study', 'map-hero-1', { x: 5, y: 8 }),
  })
  assert.equal(enteredStudy.status, 200, enteredStudy.text)

  const aroundTable = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: 'ares-move-around-table', body: commandBody('ares-move-around-table', 'map-hero-1', { x: 14, y: 7 }),
  })
  assert.equal(aroundTable.status, 200, aroundTable.text)
  const aroundTableActor = aroundTable.body.authoritative_state.players.find((player) => player.id === 'map-hero-1')
  assert.deepEqual([aroundTableActor.x, aroundTableActor.y], [14, 7])
  const aroundTableEvent = aroundTable.body.mechanics.find((event) => event.event_type === 'ActorMoved' && event.actor_id === 'map-hero-1')
  assert.ok(aroundTableEvent?.payload?.path?.length, 'маршрут вокруг стола должен быть записан в ActorMoved')
  const tableFootprint = new Set(map.props.find((prop) => prop.id === 'war-table').footprint.map((cell) => `${cell.x},${cell.y}`))
  assert.ok(aroundTableEvent.payload.path.every((cell) => !tableFootprint.has(`${cell.x},${cell.y}`)), 'серверный путь не должен проходить по footprint стола')

  const foreign = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: guestCookie, key: 'ares-foreign-actor', body: commandBody('ares-foreign-actor', 'map-hero-1', { x: 10, y: 9 }),
  })
  assert.equal(foreign.status, 403, String(foreign.body?.code ?? foreign.text.slice(0, 240)))
  assert.match(String(foreign.body?.code), /ACTOR|COMMAND|FORBIDDEN/u)

  const successBody = commandBody('ares-move-success', 'map-hero-1', { x: 10, y: 9 })
  const moved = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: 'ares-move-success', body: successBody,
  })
  assert.equal(moved.status, 200, moved.text)
  assert.deepEqual(
    [moved.body.authoritative_state.players.find((player) => player.id === 'map-hero-1').x, moved.body.authoritative_state.players.find((player) => player.id === 'map-hero-1').y],
    [10, 9],
  )
  const movedVersion = moved.body.authoritative_state.state_version
  const replay = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: 'ares-move-success', body: successBody,
  })
  assert.equal(replay.status, 200, replay.text)
  assert.equal(replay.body.idempotent_replay, true)
  assert.equal(replay.body.authoritative_state.state_version, movedVersion)
  assert.deepEqual(
    [replay.body.authoritative_state.players.find((player) => player.id === 'map-hero-1').x, replay.body.authoritative_state.players.find((player) => player.id === 'map-hero-1').y],
    [10, 9],
  )

  const beforeRestart = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: ownerCookie })
  assert.equal(beforeRestart.status, 200, beforeRestart.text)
  const mapBeforeRestart = beforeRestart.body.state.scene.map
  const versionBeforeRestart = beforeRestart.body.version
  await stopServer(child)
  child = null
  await launch()
  const afterRestart = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: ownerCookie })
  assert.equal(afterRestart.status, 200, afterRestart.text)
  assert.equal(afterRestart.body.version, versionBeforeRestart)
  assert.deepEqual(afterRestart.body.state.scene.map, mapBeforeRestart)
  assert.deepEqual([statePosition(afterRestart, 'map-hero-1').x, statePosition(afterRestart, 'map-hero-1').y], [10, 9])
  assert.equal(logs.includes('skazanie_session='), false, 'тестовый лог не должен содержать cookies')
})

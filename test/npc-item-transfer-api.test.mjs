import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
import { runnerTimeout } from './shared-runner-timeout.mjs'
  createTacticalMap,
  serializeTacticalMap,
  setCell,
} from '../server/tactical-map.mjs'

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
      ADMIN_SETUP_TOKEN: 'npc-transfer-api-setup',
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

function sessionCookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

function mapForScene() {
  const map = createTacticalMap({
    width: 4,
    height: 4,
    locationId: 'market',
    seed: 'npc-transfer-api',
  })
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      setCell(map, x, y, { passable: true, revealed: true, material: 'stone' })
    }
  }
  return serializeTacticalMap(map)
}

function initialState() {
  return {
    state_version: 0,
    sessionCode: 'NPC-TRANSFER-API',
    campaign: 'Передача NPC',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      character: 'Лира',
      hp: 16,
      maxHp: 16,
      armor: 14,
      abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
      inventory: [
        {
          id: 'gift',
          name: 'Запечатанный подарок',
          type: 'other',
          quantity: 4,
          weight: 1,
        },
        {
          id: 'torch',
          name: 'Факел',
          type: 'gear',
          quantity: 1,
          weight: 1,
        },
      ],
    }],
    scene: {
      title: 'Рынок',
      location: 'Рынок',
      location_id: 'market',
      map: mapForScene(),
    },
    social: {
      npcs: [{
        id: 'marta',
        name: 'Марта',
        role: 'трактирщица',
        location: 'Рынок',
        visibility: 'party',
        available: true,
      }],
      relationships: {},
      conversations: [],
      promises: [],
    },
    npc_world: {
      schema_version: 2,
      placements: [{
        npc_id: 'marta',
        location_id: 'market',
        x: 2,
        y: 2,
        placement_reason: 'api-test',
      }],
      vitals: { marta: { hp: 4, max_hp: 4, alive: true } },
      stances: {},
      inventories: {},
    },
  }
}

test('HTTP TransferItem передаёт предмет видимому NPC с ACL, idempotency и приватным restart projection', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-npc-transfer-api-'))
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
      email: 'gm@npc-transfer.test',
      password: 'secure-admin-password',
      setupToken: 'npc-transfer-api-setup',
    },
  })
  assert.equal(admin.status, 201, `${admin.text}\n${logs}`)
  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Owner', email: 'owner@npc-transfer.test', password: 'secure-owner-password' },
  })
  assert.equal(owner.status, 201, `${owner.text}\n${logs}`)
  const foreign = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Foreign', email: 'foreign@npc-transfer.test', password: 'secure-foreign-password' },
  })
  assert.equal(foreign.status, 201, `${foreign.text}\n${logs}`)
  const adminCookie = sessionCookie(admin)
  const ownerCookie = sessionCookie(owner)
  const foreignCookie = sessionCookie(foreign)

  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const ownerUser = users.body.users.find((candidate) => candidate.email === 'owner@npc-transfer.test')
  const ownership = await request(baseUrl, `/api/admin/users/${ownerUser.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { heroIds: ['hero'] },
  })
  assert.equal(ownership.status, 200, `${ownership.text}\n${logs}`)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      code: 'NPC-TRANSFER-API',
      name: 'Передача NPC',
      state: initialState(),
    },
  })
  assert.equal(created.status, 201, `${created.text}\n${logs}`)

  const key = 'npc-transfer-http-idempotent'
  const commandBody = {
    idempotency_key: key,
    command: {
      command_type: 'TransferItem',
      actor_id: 'hero',
      item_id: 'gift',
      recipient_id: 'marta',
      quantity: 2,
    },
  }
  const foreignAttempt = await request(baseUrl, '/api/campaigns/NPC-TRANSFER-API/commands', {
    method: 'POST',
    cookie: foreignCookie,
    key: 'foreign-transfer',
    body: { ...commandBody, idempotency_key: 'foreign-transfer' },
  })
  assert.equal(foreignAttempt.status, 403, `${foreignAttempt.text}\n${logs}`)

  const first = await request(baseUrl, '/api/campaigns/NPC-TRANSFER-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    key,
    body: commandBody,
  })
  assert.equal(first.status, 200, `${first.text}\n${logs}`)
  assert.equal(first.body.mechanics[0].event_type, 'ItemTransferred')
  assert.equal(first.body.mechanics[0].payload.recipient_kind, 'npc')
  assert.equal(first.body.authoritative_state.players[0].inventory.find((item) => item.id === 'gift').quantity, 2)
  assert.equal(first.body.authoritative_state.npc_world, undefined)
  assert.doesNotMatch(JSON.stringify(first.body.authoritative_state), /inventories/u)

  const duplicate = await request(baseUrl, '/api/campaigns/NPC-TRANSFER-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    key,
    body: commandBody,
  })
  assert.equal(duplicate.status, 200, `${duplicate.text}\n${logs}`)
  assert.equal(duplicate.body.idempotent_replay, true)
  assert.equal(duplicate.body.authoritative_state.players[0].inventory.find((item) => item.id === 'gift').quantity, 2)

  const adminRoom = await request(baseUrl, '/api/rooms/NPC-TRANSFER-API', { cookie: adminCookie })
  assert.equal(adminRoom.status, 200, `${adminRoom.text}\n${logs}`)
  assert.equal(adminRoom.body.state.npc_world.inventories.marta.length, 1)
  assert.equal(adminRoom.body.state.npc_world.inventories.marta[0].quantity, 2)

  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const meAfterRestart = await request(baseUrl, '/api/auth/me', { cookie: ownerCookie })
  assert.equal(meAfterRestart.status, 200, `${meAfterRestart.text}\n${logs}`)
  const roomAfterRestart = await request(baseUrl, '/api/rooms/NPC-TRANSFER-API', { cookie: ownerCookie })
  assert.equal(roomAfterRestart.status, 200, `${roomAfterRestart.text}\n${logs}`)
  assert.equal(roomAfterRestart.body.state.players[0].inventory.find((item) => item.id === 'gift').quantity, 2)
  assert.equal(roomAfterRestart.body.state.npc_world, undefined)
  assert.doesNotMatch(JSON.stringify(roomAfterRestart.body.state), /inventories/u)

  const replayAfterRestart = await request(baseUrl, '/api/campaigns/NPC-TRANSFER-API/commands', {
    method: 'POST',
    cookie: ownerCookie,
    key,
    body: commandBody,
  })
  assert.equal(replayAfterRestart.status, 200, `${replayAfterRestart.text}\n${logs}`)
  assert.equal(replayAfterRestart.body.idempotent_replay, true)
  assert.equal(replayAfterRestart.body.authoritative_state.players[0].inventory.find((item) => item.id === 'gift').quantity, 2)
  assert.equal(replayAfterRestart.body.authoritative_state.npc_world, undefined)

  const durableAdminRoom = await request(baseUrl, '/api/rooms/NPC-TRANSFER-API', { cookie: adminCookie })
  assert.equal(durableAdminRoom.status, 200, `${durableAdminRoom.text}\n${logs}`)
  assert.equal(durableAdminRoom.body.state.npc_world.inventories.marta.length, 1)
  assert.equal(durableAdminRoom.body.state.npc_world.inventories.marta[0].quantity, 2)
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null, response }
}

function cookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited\n${logs()}`)
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`Server did not start\n${logs()}`)
}

test('non-admin room and Director response cannot expose private world memory', { timeout: 30_000 }, async (t) => {
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-viewer-api-'))
  let logs = ''
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'viewer-api-token', GAME_ENGINE_MODE: 'enforce', COOKIE_SECURE: 'false', NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { logs += String(chunk) })
  child.stderr.on('data', (chunk) => { logs += String(chunk) })
  t.after(() => { if (child.exitCode == null) child.kill(); rmSync(storage, { recursive: true, force: true }) })
  await waitForHealth(baseUrl, child, () => logs)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST', body: { name: 'GM', email: 'gm@viewer.test', password: 'viewer-admin-password', setupToken: 'viewer-api-token' },
  })
  assert.equal(setup.status, 201, logs)
  const adminCookie = cookie(setup)
  const registration = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: { name: 'Player', email: 'player@viewer.test', password: 'viewer-player-password' },
  })
  assert.equal(registration.status, 201, logs)
  const playerCookie = cookie(registration)
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const playerUser = users.body.users.find((candidate) => candidate.email === 'player@viewer.test')
  const access = await request(baseUrl, `/api/admin/users/${playerUser.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero'] },
  })
  assert.equal(access.status, 200, logs)

  const privateMarker = 'GM_PRIVATE_DRAGON_COUNCIL'
  const initialState = {
    sessionCode: 'VIEWER-API', campaign: 'Visibility', partyMemberIds: ['hero'], activePlayerId: 'hero', engine_mode: 'enforce',
    isNarrating: false, pendingCheck: null, suggestions: [], messages: [], enemies: [], entities: [], economyLog: [],
    players: [{ id: 'hero', character: 'Лира', hp: 18, maxHp: 18, armor: 14, abilities: { cha: 14 }, inventory: [], currency: { gold: 20 }, online: true }],
    scene: {
      title: 'Склеп', location: 'Склеп', mood: 'Тихо', objective: 'Выйти', turn: 1,
      cells: [{ x: 0, y: 0, type: 'floor', revealed: false, feature: 'enemy', secret: privateMarker }],
      hidden_information: { ambush: privateMarker },
    },
    adventure: {
      chapter: 1, currentHook: 'Публичная печать', history: [], visitedLocations: ['Склеп'],
      gm_only: { villain: privateMarker }, hidden_information: { route: privateMarker },
    },
    merchants: [{
      id: 'old-shop', name: 'Скрытая лавка', location: 'Склеп', available: true,
      stock: [{ stock_id: 'torch', catalog_id: 'srd_5_2_1:torch', name: 'Факел', type: 'gear', quantity: 1, secret_supplier: privateMarker }],
      pricing: { mode: 'catalog', agent_adjustment_bps: -500, bargain_dc: 1 }, bargains: { hero: { success: true } }, secret: privateMarker,
    }],
    agentInteraction: {
      id: 'visibility-vote', type: 'vote', status: 'resolved', resolvedOptionId: 'city', votes: { hero: 'city' },
      options: [{ id: 'city', label: 'Уходим из склепа и идём в большой город Норвин' }],
    },
  }
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: 'VIEWER-API', state: initialState },
  })
  assert.equal(created.status, 201, logs)

  const playerRoom = await request(baseUrl, '/api/rooms/VIEWER-API', { cookie: playerCookie })
  assert.equal(playerRoom.status, 200, logs)
  assert.doesNotMatch(JSON.stringify(playerRoom.body), new RegExp(privateMarker, 'u'))
  assert.equal(playerRoom.body.state.scene.cells[0].feature, undefined)
  assert.equal(playerRoom.body.state.merchants[0].bargains, undefined)
  assert.equal(playerRoom.body.state.merchants[0].pricing.agent_adjustment_bps, undefined)

  const transitioned = await request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: playerCookie,
    body: { campaignId: 'VIEWER-API', idempotency_key: 'viewer-city-transition', action: '[РЕШЕНИЕ ГРУППЫ] Уходим из склепа и идём в большой город Норвин' },
  })
  assert.equal(transitioned.status, 200, `${JSON.stringify(transitioned.body)}\n${logs}`)
  assert.doesNotMatch(JSON.stringify(transitioned.body), new RegExp(privateMarker, 'u'))
  assert.ok(transitioned.body.authoritative_state, JSON.stringify(transitioned.body))
  assert.equal(transitioned.body.authoritative_state.scene.location, 'Большой город Норвин')
  assert.equal(transitioned.body.authoritative_state.messages.some((message) => message.id === transitioned.body.narration_message_id), true)
  assert.equal(transitioned.body.mechanics.some((event) => event.event_type === 'SceneAdvanced'), true)
  assert.equal(transitioned.body.authoritative_state.merchants.every((merchant) => merchant.location === 'Большой город Норвин'), true)
  assert.equal(transitioned.body.authoritative_state.merchants.every((merchant) => merchant.bargains === undefined), true)

  const adminRoom = await request(baseUrl, '/api/rooms/VIEWER-API', { cookie: adminCookie })
  assert.equal(adminRoom.status, 200, logs)
  assert.equal(adminRoom.body.state.adventure.gm_only.villain, privateMarker)
})

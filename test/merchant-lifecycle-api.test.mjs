import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
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
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: setupToken, GAME_ENGINE_MODE: 'shadow',
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
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not stop')), 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, log) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited with ${child.exitCode}\n${log()}`)
    try { const response = await fetch(`${baseUrl}/api/health`); if (response.ok) return response.json() } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Test server did not become healthy\n${log()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie, body, idempotencyKey } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : JSON_HEADERS),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* assertion includes raw text */ }
  return { response, status: response.status, body: json, text }
}

function cookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

function assertStatus(result, expected, log) {
  assert.equal(result.status, expected, `${result.text}\n${log()}`)
  assert.ok(result.body && typeof result.body === 'object')
}

function lifecycleCommand(baseUrl, campaignId, sessionCookie, idempotencyKey, command) {
  return request(baseUrl, `/api/campaigns/${campaignId}/merchants/commands`, {
    method: 'POST', cookie: sessionCookie, idempotencyKey, body: { command },
  })
}

function stateVersion(result) {
  return Number(result.body?.authoritative_state?.state_version ?? result.body?.state_version)
}

test('admin merchant lifecycle API is enforce-only, event-sourced, idempotent, projected and rate-limited', { timeout: runnerTimeout(50_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-merchant-lifecycle-api-'))
  const setupToken = 'merchant-lifecycle-setup-token'
  let logs = ''
  let child = null
  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  const log = () => logs
  const appendLog = (chunk) => { logs += chunk }
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })

  child = startServer({ port, storage, setupToken, appendLog })
  await waitForHealth(baseUrl, child, log)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST', body: { name: 'Lifecycle Admin', email: 'admin@merchant-lifecycle.test', password: 'very-secure-admin-password', setupToken },
  })
  assertStatus(setup, 201, log)
  const adminCookie = cookie(setup)
  const registered = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: { name: 'Lifecycle Player', email: 'player@merchant-lifecycle.test', password: 'very-secure-player-password' },
  })
  assertStatus(registered, 201, log)
  const playerCookie = cookie(registered)

  const initialState = {
    sessionCode: 'SHOP-LIFECYCLE', campaign: 'Merchant lifecycle', partyName: 'Customers', partyMemberIds: ['hero'],
    activePlayerId: 'hero', engine_mode: 'shadow', isNarrating: false, pendingCheck: null, suggestions: [], messages: [], merchants: [], economyLog: [],
    players: [{ id: 'hero', name: 'Player', character: 'Aster', hp: 10, maxHp: 10, armor: 12, abilities: { cha: 12 }, inventory: [], currency: { gold: 10 }, online: true }],
    scene: { title: 'Market', location: 'Рыночная площадь', mood: 'Busy', objective: 'Trade', turn: 1, cells: [] },
    adventure: { chapter: 1, history: [], visitedLocations: ['Рыночная площадь'] },
  }
  const createdCampaign = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: 'SHOP-LIFECYCLE', name: initialState.campaign, state: initialState },
  })
  assertStatus(createdCampaign, 201, log)
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const player = users.body.users.find((candidate) => candidate.email === 'player@merchant-lifecycle.test')
  const assigned = await request(baseUrl, `/api/admin/users/${player.id}`, { method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero'] } })
  assertStatus(assigned, 200, log)

  const playerDenied = await lifecycleCommand(baseUrl, 'SHOP-LIFECYCLE', playerCookie, 'player-create-merchant', {
    command_type: 'CreateMerchant', expected_state_version: 0, merchant: { id: 'forged', name: 'Forged' },
  })
  assertStatus(playerDenied, 403, log)
  const playerAssemblyDenied = await request(baseUrl, '/api/campaigns/SHOP-LIFECYCLE/merchants/assemble', {
    method: 'POST', cookie: playerCookie, idempotencyKey: 'player-assemble', body: {
      expected_state_version: 0, settlement_type: 'town', theme: 'general', seed: 'player-forged', budget_cp: 20_000,
    },
  })
  assertStatus(playerAssemblyDenied, 403, log)
  let room = await request(baseUrl, '/api/rooms/SHOP-LIFECYCLE', { cookie: adminCookie })
  assertStatus(room, 200, log)
  let version = Number(room.body.state.state_version)

  const noKey = await request(baseUrl, '/api/campaigns/SHOP-LIFECYCLE/merchants/commands', {
    method: 'POST', cookie: adminCookie, body: { command: { command_type: 'CreateMerchant', expected_state_version: version, merchant: { id: 'nokey', name: 'No key' } } },
  })
  assertStatus(noKey, 400, log)
  assert.equal(noKey.body.code, 'IDEMPOTENCY_KEY_REQUIRED')

  const genericBypass = await request(baseUrl, '/api/campaigns/SHOP-LIFECYCLE/commands', {
    method: 'POST', cookie: adminCookie, body: { idempotency_key: 'generic-lifecycle-bypass', command: { command_type: 'CreateMerchant', expected_state_version: version, merchant: { id: 'bypass', name: 'Bypass' } } },
  })
  assertStatus(genericBypass, 400, log)
  assert.equal(genericBypass.body.code, 'MERCHANT_LIFECYCLE_ENDPOINT_REQUIRED')

  const createCommand = {
    command_type: 'CreateMerchant', expected_state_version: version,
    merchant: {
      id: 'marten.shop', name: 'Мартен', title: 'Снабженец', greeting: 'Добро пожаловать.', voice: 'Спокойный и деловой.',
      location: 'Рыночная площадь', available: true,
      pricing: { mode: 'catalog_with_agent_adjustment', buy_markup_bps: 11_000, sell_rate_bps: 5_000, agent_adjustment_bps: 500 },
      stock: [{ stock_id: 'torch', catalog_id: 'srd_5_2_1:torch', quantity: 3, name: 'Факел', type: 'tool' }],
      ignored_secret: 'must not reach the event',
    },
  }
  const created = await lifecycleCommand(baseUrl, 'SHOP-LIFECYCLE', adminCookie, 'lifecycle-create-marten', createCommand)
  assertStatus(created, 200, log)
  assert.equal(created.body.mechanics[0].event_type, 'MerchantCreated')
  assert.equal(created.body.authoritative_state.merchants[0].id, 'marten.shop')
  assert.equal(created.body.authoritative_state.merchants[0].ignored_secret, undefined)
  assert.match(created.body.mechanics[0].payload.request_fingerprint, /^[a-f0-9]{64}$/)
  version = stateVersion(created)

  const replayed = await lifecycleCommand(baseUrl, 'SHOP-LIFECYCLE', adminCookie, 'lifecycle-create-marten', createCommand)
  assertStatus(replayed, 200, log)
  assert.equal(replayed.body.idempotent_replay, true)
  assert.equal(replayed.body.authoritative_state.merchants.length, 1)
  assert.equal(stateVersion(replayed), version)

  const keyReuse = await lifecycleCommand(baseUrl, 'SHOP-LIFECYCLE', adminCookie, 'lifecycle-create-marten', {
    command_type: 'MoveMerchant', expected_state_version: version, merchant_id: 'marten.shop', location: 'Старый порт',
  })
  assertStatus(keyReuse, 409, log)
  assert.equal(keyReuse.body.code, 'IDEMPOTENCY_CONFLICT')

  const staleConfigure = await lifecycleCommand(baseUrl, 'SHOP-LIFECYCLE', adminCookie, 'lifecycle-stale-configure', {
    command_type: 'ConfigureMerchant', expected_state_version: createCommand.expected_state_version, merchant_id: 'marten.shop',
    configuration: { title: 'Устаревшее изменение' },
  })
  assertStatus(staleConfigure, 409, log)
  assert.equal(staleConfigure.body.code, 'STATE_VERSION_CONFLICT')

  const configured = await lifecycleCommand(baseUrl, 'SHOP-LIFECYCLE', adminCookie, 'lifecycle-configure-marten', {
    command_type: 'ConfigureMerchant', expected_state_version: version, merchant_id: 'marten.shop',
    configuration: { title: 'Главный снабженец', greeting: 'Товар проверен.', pricing: { buy_markup_bps: 10_500, agent_adjustment_bps: -250 }, forbidden: 'discard me' },
  })
  assertStatus(configured, 200, log)
  assert.equal(configured.body.mechanics[0].event_type, 'MerchantConfigured')
  assert.equal(configured.body.authoritative_state.merchants[0].title, 'Главный снабженец')
  version = stateVersion(configured)

  const restocked = await lifecycleCommand(baseUrl, 'SHOP-LIFECYCLE', adminCookie, 'lifecycle-restock-marten', {
    command_type: 'RestockMerchant', expected_state_version: version, merchant_id: 'marten.shop',
    items: [
      { stock_id: 'torch', quantity: 2 },
      { stock_id: 'rope', catalog_id: 'srd_5_2_1:rope-hempen-50-feet', quantity: 4, name: 'Пеньковая верёвка', type: 'tool' },
    ],
  })
  assertStatus(restocked, 200, log)
  assert.equal(restocked.body.mechanics[0].event_type, 'MerchantRestocked')
  assert.equal(restocked.body.authoritative_state.merchants[0].stock.find((entry) => entry.stock_id === 'torch').quantity, 5)
  assert.equal(restocked.body.authoritative_state.merchants[0].stock.find((entry) => entry.stock_id === 'rope').quantity, 4)
  version = stateVersion(restocked)

  const moved = await lifecycleCommand(baseUrl, 'SHOP-LIFECYCLE', adminCookie, 'lifecycle-move-marten', {
    command_type: 'MoveMerchant', expected_state_version: version, merchant_id: 'marten.shop', location: 'Старый порт',
  })
  assertStatus(moved, 200, log)
  assert.equal(moved.body.mechanics[0].event_type, 'MerchantMoved')
  assert.equal(moved.body.authoritative_state.merchants[0].location, 'Старый порт')
  version = stateVersion(moved)

  const unavailable = await lifecycleCommand(baseUrl, 'SHOP-LIFECYCLE', adminCookie, 'lifecycle-disable-marten', {
    command_type: 'SetMerchantAvailability', expected_state_version: version, merchant_id: 'marten.shop', available: false,
  })
  assertStatus(unavailable, 200, log)
  assert.equal(unavailable.body.mechanics[0].event_type, 'MerchantAvailabilityChanged')
  assert.equal(unavailable.body.authoritative_state.merchants[0].available, false)
  version = stateVersion(unavailable)

  const assembledBody = {
    expected_state_version: version,
    settlement_type: 'town',
    theme: 'provisions',
    seed: 'lifecycle-api-provisioner',
    budget_cp: 20_000,
    director_intent: {
      stock: [
        { catalog_id: 'srd_5_2_1:potion-of-healing', quantity: 2 },
        { catalog_id: 'srd_5_2_1:torch', quantity: 4 },
      ],
      agent_adjustment_bps: -500,
    },
  }
  const assembled = await request(baseUrl, '/api/campaigns/SHOP-LIFECYCLE/merchants/assemble', {
    method: 'POST', cookie: adminCookie, idempotencyKey: 'assemble-provisioner', body: assembledBody,
  })
  assertStatus(assembled, 200, log)
  assert.equal(assembled.body.shop_proposal.source, 'deterministic-shop-assembler')
  assert.equal(assembled.body.shop_proposal.merchant.location, 'Рыночная площадь')
  assert.equal(assembled.body.mechanics[0].event_type, 'MerchantCreated')
  assert.equal(assembled.body.shop_proposal.merchant.stock.every((entry) => entry.catalog_id.startsWith('srd_5_2_1:')), true)
  assert.equal(assembled.body.authoritative_state.merchants.length, 2)
  assert.equal(assembled.body.authoritative_state.merchants[1].pricing.agent_adjustment_bps, -500)
  version = stateVersion(assembled)

  const assembledReplay = await request(baseUrl, '/api/campaigns/SHOP-LIFECYCLE/merchants/assemble', {
    method: 'POST', cookie: adminCookie, idempotencyKey: 'assemble-provisioner', body: assembledBody,
  })
  assertStatus(assembledReplay, 200, log)
  assert.equal(assembledReplay.body.idempotent_replay, true)
  assert.equal(assembledReplay.body.shop_proposal.proposal_id, assembled.body.shop_proposal.proposal_id)
  assert.equal(assembledReplay.body.authoritative_state.merchants.length, 2)

  const forgedAssembly = await request(baseUrl, '/api/campaigns/SHOP-LIFECYCLE/merchants/assemble', {
    method: 'POST', cookie: adminCookie, idempotencyKey: 'assemble-forged-price', body: {
      expected_state_version: version, settlement_type: 'town', theme: 'provisions', seed: 'forged', budget_cp: 20_000,
      director_intent: { stock: [{ catalog_id: 'srd_5_2_1:torch', quantity: 1, base_price_cp: 999_999 }], agent_adjustment_bps: 0 },
    },
  })
  assertStatus(forgedAssembly, 400, log)
  assert.equal(forgedAssembly.body.code, 'UNEXPECTED_DIRECTOR_STOCK_FIELD')

  room = await request(baseUrl, '/api/rooms/SHOP-LIFECYCLE', { cookie: adminCookie })
  assertStatus(room, 200, log)
  assert.equal(room.body.state.state_version, version)
  assert.equal(room.body.state.merchants[0].location, 'Старый порт')
  assert.equal(room.body.state.merchants[0].available, false)

  await stopServer(child)
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, setupToken, appendLog })
  await waitForHealth(baseUrl, child, log)
  const login = await request(baseUrl, '/api/auth/login', {
    method: 'POST', body: { email: 'admin@merchant-lifecycle.test', password: 'very-secure-admin-password' },
  })
  assertStatus(login, 200, log)
  const restartedAdminCookie = cookie(login)
  const durableRoom = await request(baseUrl, '/api/rooms/SHOP-LIFECYCLE', { cookie: restartedAdminCookie })
  assertStatus(durableRoom, 200, log)
  assert.equal(durableRoom.body.state.state_version, version)
  assert.equal(durableRoom.body.state.merchants[0].stock.find((entry) => entry.stock_id === 'torch').quantity, 5)
  assert.equal(durableRoom.body.state.merchants.length, 2)

  let rateLimited = null
  for (let attempt = 0; attempt < 65; attempt += 1) {
    const response = await request(baseUrl, '/api/campaigns/SHOP-LIFECYCLE/merchants/commands', {
      method: 'POST', cookie: restartedAdminCookie, idempotencyKey: `rate-${attempt}`, body: {},
    })
    if (response.status === 429) { rateLimited = response; break }
    assert.equal(response.status, 400, `${response.text}\n${log()}`)
  }
  assert.ok(rateLimited, 'admin lifecycle endpoint must enforce its dedicated rate limit')
  assert.equal(rateLimited.body.code, 'MERCHANT_LIFECYCLE_RATE_LIMITED')
})

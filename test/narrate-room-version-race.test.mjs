import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake RouterAI did not expose a TCP port')
  return address.port
}

async function closeServer(server) {
  if (!server.listening) return
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function startGameServer({ port, storage, routerBaseUrl, setupToken, appendLog }) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: 'room-version-race-test-key',
      ROUTERAI_BASE_URL: routerBaseUrl,
      ADMIN_SETUP_TOKEN: setupToken,
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopGameServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test game server did not stop')), 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, log) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test game server exited with ${child.exitCode}\n${log()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Test game server did not become healthy\n${log()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* assertion below reports the raw body */ }
  return { response, status: response.status, body: json, text }
}

function cookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

function assertStatus(result, status, log) {
  assert.equal(result.status, status, `${result.text}\n${log()}`)
  assert.ok(result.body && typeof result.body === 'object')
}

test('/api/narrate keeps its event projection authoritative while broad room PUT is retired', { timeout: 20_000 }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-narrate-version-race-'))
  const setupToken = 'narrate-version-race-setup-token'
  let logs = ''
  let child = null
  let releaseProvider
  let providerStarted
  const providerGate = new Promise((resolve) => { releaseProvider = resolve })
  const providerRequest = new Promise((resolve) => { providerStarted = resolve })

  const fakeRouter = createHttpServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/v1/chat/completions') {
      res.writeHead(404, JSON_HEADERS)
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }
    req.resume()
    req.once('end', async () => {
      providerStarted()
      await providerGate
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({
        model: 'fake-room-version-model',
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({
              narration: 'Бранн внимательно осматривает место встречи, отмечая следы недавнего присутствия.',
              suggestions: ['Проверить следы у входа'],
              turn_consumed: true,
              action_kind: 'substantive',
            }),
          },
        }],
      }))
    })
  })

  t.after(async () => {
    releaseProvider()
    await stopGameServer(child)
    await closeServer(fakeRouter)
    rmSync(storage, { recursive: true, force: true })
  })

  const routerPort = await listen(fakeRouter)
  const gamePort = await freePort()
  const baseUrl = `http://127.0.0.1:${gamePort}`
  const log = () => logs
  child = startGameServer({
    port: gamePort,
    storage,
    routerBaseUrl: `http://127.0.0.1:${routerPort}/api/v1`,
    setupToken,
    appendLog: (chunk) => { logs += chunk },
  })
  await waitForHealth(baseUrl, child, log)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: {
      name: 'Version Race Admin',
      email: 'admin@narrate-version-race.test',
      password: 'very-secure-admin-password',
      setupToken,
    },
  })
  assertStatus(setup, 201, log)
  const adminCookie = cookie(setup)

  const state = {
    sessionCode: 'VERSION-RACE',
    campaign: 'Narration version race',
    activePlayerId: 'brann',
    isNarrating: false,
    pendingCheck: null,
    agentInteraction: null,
    suggestions: [],
    messages: [],
    players: [{
      id: 'brann', character: 'Бранн', hp: 12, maxHp: 12, armor: 16,
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 14, cha: 10 },
      proficiency: 2, inventory: [], online: true,
    }],
    scene: { title: 'Место встречи', location: 'Кольцевая станция «Гелиос»', mood: '', objective: '', turn: 1, cells: [] },
    adventure: { chapter: 1, visitedLocations: ['Кольцевая станция «Гелиос»'], history: [] },
    ruleset_id: 'srd_5_2_1',
    ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'],
    state_version: 0,
  }
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: 'VERSION-RACE', state },
  })
  assertStatus(created, 201, log)
  const initialVersion = created.body.version

  const narrationPromise = request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: adminCookie,
    body: {
      campaignId: 'VERSION-RACE',
      action: 'Осмотреть место встречи',
      idempotency_key: 'narrate-room-version-race-1',
    },
  })

  await providerRequest

  const roomBeforePending = await request(baseUrl, '/api/rooms/VERSION-RACE', { cookie: adminCookie })
  assertStatus(roomBeforePending, 200, log)
  assert.ok(roomBeforePending.body.version >= initialVersion,
    'recovery projection may advance the compatibility-room version while narration is pending')

  const retiredWrite = await request(baseUrl, '/api/rooms/VERSION-RACE', {
    method: 'PUT', cookie: adminCookie,
    body: { state: roomBeforePending.body.state, baseVersion: roomBeforePending.body.version },
  })
  assertStatus(retiredWrite, 410, log)
  assert.equal(retiredWrite.body.code, 'ROOM_MUTATION_RETIRED')

  releaseProvider()
  const narrated = await narrationPromise
  assertStatus(narrated, 200, log)
  const finalRoom = await request(baseUrl, '/api/rooms/VERSION-RACE', { cookie: adminCookie })
  assertStatus(finalRoom, 200, log)
  assert.ok(narrated.body.room_version >= roomBeforePending.body.version,
    'narrate must return an authoritative projection at least as recent as the read before it committed')
  assert.equal(narrated.body.room_version, finalRoom.body.version,
    'narrate must return the version of its final authoritative state')
})

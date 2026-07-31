import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  NPC_PORTRAIT_GENERATION_LIMIT,
  NPC_PORTRAIT_ROLE_ASSETS,
} from '../server/npc-portraits.mjs'

const WEBP = Buffer.from('524946460400000057454250', 'hex')

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

function startServer({ port, storage, providerBaseUrl, appendLog }) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: 'portrait-api-test-key',
      ROUTERAI_BASE_URL: providerBaseUrl,
      DND_IMAGE_MODEL: 'test/portrait-image-v1',
      DND_AI_MODEL: 'test/text-model',
      DND_AI_FALLBACK_MODELS: '',
      ADMIN_SETUP_TOKEN: 'portrait-api-setup',
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
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, log) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited with ${child.exitCode}\n${log()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return response
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Test server did not become healthy\n${log()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie, body, headers, redirect = 'follow' } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    redirect,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function json(response) {
  const text = await response.text()
  try { return text ? JSON.parse(text) : null }
  catch { throw new Error(`Ожидался JSON, получено: ${text}`) }
}

function cookie(response) {
  return response.headers.get('set-cookie')?.split(';')[0]
}

function npc(id, overrides = {}) {
  return {
    id,
    name: `NPC ${id}`,
    role: 'village guard',
    location: 'Market',
    public_summary: `Публичное описание ${id}.`,
    voice: '',
    goals: [`PRIVATE_GOAL_${id}`],
    beliefs: [`PRIVATE_BELIEF_${id}`],
    known_fact_ids: [],
    social_dcs: {},
    visibility: 'party',
    available: true,
    tags: ['important'],
    schedule: [],
    inventory: [],
    ...overrides,
  }
}

test('NPC portrait API enforces auth/visibility, caches generation and rate-limits only cache misses', { timeout: runnerTimeout(40_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-npc-portrait-api-'))
  let logs = ''
  let child = null
  const imageRequests = []
  const provider = createHttpServer(async (req, res) => {
    if (req.url !== '/api/v1/images' || req.method !== 'POST') {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      return res.end('{"error":"text model disabled in portrait test"}')
    }
    let raw = ''
    for await (const chunk of req) raw += String(chunk)
    imageRequests.push({
      authorization: String(req.headers.authorization || ''),
      body: JSON.parse(raw),
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      data: [{ b64_json: WEBP.toString('base64') }],
      usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
      cost: 0.025,
    }))
  })
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve) })
  const providerAddress = provider.address()
  const providerPort = typeof providerAddress === 'object' && providerAddress ? providerAddress.port : 0
  const providerBaseUrl = `http://127.0.0.1:${providerPort}/api/v1`
  t.after(async () => {
    await stopServer(child)
    await new Promise((resolve) => provider.close(() => resolve()))
    rmSync(storage, { recursive: true, force: true })
  })

  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, providerBaseUrl, appendLog: (chunk) => { logs += chunk } })
  await waitForHealth(baseUrl, child, () => logs)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: {
      name: 'Portrait Admin',
      email: 'admin@portrait.test',
      password: 'very-secure-admin-password',
      setupToken: 'portrait-api-setup',
    },
  })
  assert.equal(setup.status, 201, logs)
  const adminCookie = cookie(setup)
  const player = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Portrait Player',
      email: 'player@portrait.test',
      password: 'very-secure-player-password',
    },
  })
  assert.equal(player.status, 201, logs)
  const playerCookie = cookie(player)
  const outsider = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Portrait Outsider',
      email: 'outsider@portrait.test',
      password: 'very-secure-outsider-password',
    },
  })
  assert.equal(outsider.status, 201, logs)
  const outsiderCookie = cookie(outsider)

  const rateNpcs = Array.from({ length: NPC_PORTRAIT_GENERATION_LIMIT }, (_, index) => npc(`npc:rate-${index}`))
  const initialState = {
    sessionCode: 'PORTRAIT-CACHE',
    campaign: 'Portrait API',
    partyName: 'Portrait Party',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    engine_mode: 'enforce',
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [{
      id: 'hero',
      name: 'Player',
      character: 'Ада',
      hp: 10,
      maxHp: 10,
      armor: 12,
      proficiency: 2,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      inventory: [],
      online: true,
    }],
    merchants: [],
    social: {
      npcs: [
        npc('npc:important', {
          name: 'Марта',
          role: 'merchant',
          public_summary: 'Торговка с серебряной прядью.',
          goals: ['PRIVATE_GOAL_FIND_CROWN'],
          beliefs: ['PRIVATE_BELIEF_DUKE_TRAITOR'],
        }),
        npc('npc:minor', {
          name: 'Страж ворот',
          role: 'city guard',
          public_summary: 'Обычный страж у ворот.',
          tags: [],
        }),
        npc('npc:hidden', {
          name: 'Скрытый советник',
          public_summary: 'GM_ONLY_SUMMARY',
          visibility: 'gm_only',
        }),
        ...rateNpcs,
      ],
      relationships: {},
      conversations: [],
      promises: [],
    },
    scene: { title: 'Market', location: 'Market', mood: 'Busy', objective: 'Talk', turn: 1, cells: [] },
    mechanics: { world_time: { elapsed_minutes: 60 } },
    adventure: { chapter: 1, history: [], visitedLocations: ['Market'] },
  }
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: adminCookie,
    body: { code: 'PORTRAIT-CACHE', name: initialState.campaign, state: initialState },
  })
  assert.equal(created.status, 201, `${await created.text()}\n${logs}`)
  const usersResponse = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const users = await json(usersResponse)
  const playerUser = users.users.find((candidate) => candidate.email === 'player@portrait.test')
  const assigned = await request(baseUrl, `/api/admin/users/${playerUser.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { heroIds: ['hero'] },
  })
  assert.equal(assigned.status, 200, `${await assigned.text()}\n${logs}`)

  const importantPath = '/api/campaigns/PORTRAIT-CACHE/npcs/npc%3Aimportant/portrait'
  const anonymous = await request(baseUrl, importantPath, { redirect: 'manual' })
  assert.equal(anonymous.status, 401)
  const forbidden = await request(baseUrl, importantPath, { cookie: outsiderCookie, redirect: 'manual' })
  assert.equal(forbidden.status, 403)
  const hidden = await request(baseUrl, '/api/campaigns/PORTRAIT-CACHE/npcs/npc%3Ahidden/portrait', {
    cookie: playerCookie,
    redirect: 'manual',
  })
  assert.equal(hidden.status, 404)
  assert.equal((await json(hidden)).code, 'NPC_NOT_VISIBLE')
  const traversal = await request(
    baseUrl,
    `/api/campaigns/PORTRAIT-CACHE/npcs/${encodeURIComponent('../../auth.json')}/portrait`,
    { cookie: playerCookie, redirect: 'manual' },
  )
  assert.equal(traversal.status, 404)

  const minor = await request(baseUrl, '/api/campaigns/PORTRAIT-CACHE/npcs/npc%3Aminor/portrait', {
    cookie: playerCookie,
    redirect: 'manual',
  })
  assert.equal(minor.status, 302)
  assert.equal(minor.headers.get('location'), NPC_PORTRAIT_ROLE_ASSETS.guard)
  assert.equal(minor.headers.get('x-npc-portrait-source'), 'static')
  assert.equal(imageRequests.length, 0)
  const usageBeforeGeneration = await json(await request(baseUrl, '/api/admin/usage', { cookie: adminCookie }))
  assert.equal(usageBeforeGeneration.usage.completed_requests, 0)
  assert.equal(usageBeforeGeneration.usage.provider_cost, 0)

  const generated = await request(baseUrl, importantPath, { cookie: playerCookie, redirect: 'manual' })
  assert.equal(generated.status, 200, logs)
  assert.equal(generated.headers.get('content-type'), 'image/webp')
  assert.equal(generated.headers.get('x-npc-portrait-source'), 'generated')
  assert.equal(generated.headers.get('x-npc-portrait-cache'), 'miss')
  assert.equal(Buffer.from(await generated.arrayBuffer()).equals(WEBP), true)
  assert.equal(imageRequests.length, 1)
  assert.equal(imageRequests[0].authorization, 'Bearer portrait-api-test-key')
  assert.equal(imageRequests[0].body.model, 'test/portrait-image-v1')
  assert.match(imageRequests[0].body.prompt, /Марта|merchant|серебряной прядью/u)
  assert.doesNotMatch(
    imageRequests[0].body.prompt,
    /PRIVATE_GOAL|PRIVATE_BELIEF|GM_ONLY|goals|beliefs|schedule|inventory/u,
  )

  const cached = await request(baseUrl, importantPath, { cookie: playerCookie, redirect: 'manual' })
  assert.equal(cached.status, 200)
  assert.equal(cached.headers.get('x-npc-portrait-cache'), 'hit')
  assert.equal(imageRequests.length, 1)
  const usageAfterCacheHit = await json(await request(baseUrl, '/api/admin/usage', { cookie: adminCookie }))
  assert.equal(usageAfterCacheHit.usage.completed_requests, 1)
  assert.equal(usageAfterCacheHit.usage.committed_tokens, 12)
  assert.equal(usageAfterCacheHit.usage.provider_cost, 0.025)
  const etag = cached.headers.get('etag')
  assert.ok(etag)
  const notModified = await request(baseUrl, importantPath, {
    cookie: playerCookie,
    headers: { 'If-None-Match': etag },
    redirect: 'manual',
  })
  assert.equal(notModified.status, 304)
  assert.equal(imageRequests.length, 1)

  const npcCacheRoot = join(storage, 'generated', 'npcs')
  const cacheDirectories = readdirSync(npcCacheRoot)
  assert.equal(cacheDirectories.length, 1)
  assert.match(cacheDirectories[0], /^[a-f0-9]{24}$/u)
  const cacheFiles = readdirSync(join(npcCacheRoot, cacheDirectories[0]))
  assert.deepEqual(cacheFiles.length, 1)
  assert.match(cacheFiles[0], /^[a-f0-9]{40}\.webp$/u)
  assert.doesNotMatch(`${cacheDirectories[0]}/${cacheFiles[0]}`, /PORTRAIT|important|npc:/u)

  for (let index = 0; index < NPC_PORTRAIT_GENERATION_LIMIT - 1; index += 1) {
    const response = await request(
      baseUrl,
      `/api/campaigns/PORTRAIT-CACHE/npcs/${encodeURIComponent(`npc:rate-${index}`)}/portrait`,
      { cookie: playerCookie, redirect: 'manual' },
    )
    assert.equal(response.status, 200, `rate-${index}\n${logs}`)
  }
  const limited = await request(
    baseUrl,
    `/api/campaigns/PORTRAIT-CACHE/npcs/${encodeURIComponent(`npc:rate-${NPC_PORTRAIT_GENERATION_LIMIT - 1}`)}/portrait`,
    { cookie: playerCookie, redirect: 'manual' },
  )
  assert.equal(limited.status, 429)
  assert.equal((await json(limited)).code, 'NPC_PORTRAIT_RATE_LIMITED')
  assert.equal(imageRequests.length, NPC_PORTRAIT_GENERATION_LIMIT)

  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  logs = ''
  child = startServer({ port, storage, providerBaseUrl, appendLog: (chunk) => { logs += chunk } })
  await waitForHealth(baseUrl, child, () => logs)
  const afterRestart = await request(baseUrl, importantPath, { cookie: playerCookie, redirect: 'manual' })
  assert.equal(afterRestart.status, 200, logs)
  assert.equal(afterRestart.headers.get('x-npc-portrait-cache'), 'hit')
  assert.equal(imageRequests.length, NPC_PORTRAIT_GENERATION_LIMIT)
})

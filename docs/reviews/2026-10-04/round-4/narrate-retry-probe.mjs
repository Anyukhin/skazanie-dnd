import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const action = 'Проверяю силу'
const MAX_LOG_CHARS = 4_000

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

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function baseState(code) {
  return {
    sessionCode: code,
    campaign: 'Narrate retry probe',
    activePlayerId: 'hero-a',
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [
      {
        id: 'hero-a', character: 'Герой', hp: 10, maxHp: 10, armor: 14,
        abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
        proficiency: 2, inventory: [], online: true,
      },
    ],
    enemies: [],
    scene: { title: 'Проверка', location: 'Площадь', mood: '', objective: '', turn: 0, cells: [] },
    social: { npcs: [], relationships: {}, conversations: [], promises: [] },
    mechanics: { world_time: { elapsed_minutes: 0 } },
    ruleset_id: 'srd_5_2_1',
    ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'],
    engine_mode: 'enforce',
    state_version: 0,
  }
}

function appendLog(log, chunk) {
  return `${log}${String(chunk)}`.slice(-MAX_LOG_CHARS)
}

async function stopChild(child, logs) {
  if (child.exitCode != null || child.signalCode != null) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not stop\n${logs()}`)), 5_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited: ${child.exitCode}\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* слушатель ещё запускается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`server did not become healthy\n${logs()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* текст сохранён для диагностики */ }
  return {
    status: response.status,
    body: json,
    text,
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
  }
}

function startBackend({ port, storage, setupToken }) {
  const emptyEnvPath = join(storage, 'empty.env')
  writeFileSync(emptyEnvPath, '', 'utf8')
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      DOTENV_CONFIG_PATH: emptyEnvPath,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: setupToken,
      GAME_ENGINE_MODE: 'enforce',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logText = ''
  const capture = (chunk) => { logText = appendLog(logText, chunk) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  return { child, logs: () => logText }
}

async function startProxy({ port, backendUrl, failureMode }) {
  const state = { failureMode, failNextNarrate: Boolean(failureMode), keys: [] }
  const proxy = createHttpServer(async (request_, response) => {
    const body = await readRequestBody(request_)
    const headers = {}
    for (const [name, value] of Object.entries(request_.headers)) {
      if (['connection', 'content-length', 'host'].includes(name)) continue
      if (value !== undefined) headers[name] = value
    }
    try {
      const upstream = await fetch(`${backendUrl}${request_.url}`, {
        method: request_.method,
        headers,
        ...(body.length ? { body } : {}),
      })
      const bytes = Buffer.from(await upstream.arrayBuffer())
      if (request_.url === '/api/narrate' && request_.method === 'POST') {
        let parsed = {}
        try { parsed = JSON.parse(body.toString('utf8') || '{}') } catch { /* проверку JSON выполняет backend */ }
        state.keys.push(String(parsed.idempotency_key ?? ''))
        if (state.failNextNarrate) {
          state.failNextNarrate = false
          if (failureMode === 'drop') {
            response.destroy()
            return
          }
          if (failureMode === '503') {
            response.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close' })
            response.end(JSON.stringify({ error: 'synthetic proxy failure after upstream commit', code: 'PROXY_DROP_AFTER_COMMIT' }))
            return
          }
        }
      }
      response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' })
      response.end(bytes)
    } catch (error) {
      if (!response.destroyed) {
        response.writeHead(502, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    }
  })
  await listen(proxy, port)
  return { proxy, state }
}

function eventFiles(storage) {
  const campaignsRoot = join(storage, 'engine', 'campaigns')
  if (!readdirSync(campaignsRoot, { withFileTypes: true }).length) return []
  const campaignDir = readdirSync(campaignsRoot, { withFileTypes: true })
    .find((entry) => entry.isDirectory())
  if (!campaignDir) return []
  const eventsDir = join(campaignsRoot, campaignDir.name, 'events')
  return readdirSync(eventsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ name, value: JSON.parse(readFileSync(join(eventsDir, name), 'utf8')) }))
}

function ledger(storage, state) {
  const commits = eventFiles(storage).map(({ value }) => value)
  const events = commits.flatMap((commit) => commit.events ?? [])
  const rolls = events
    // У проверок характеристик авторитетный бросок находится внутри события;
    // у части других механик есть отдельное событие DieRolled. Включаем обе
    // формы в журнал.
    .filter((event) => event.event_type === 'DieRolled' || event.event_type === 'AbilityCheckResolved')
    .map((event) => ({
      event_type: event.event_type,
      roll_id: event.payload?.roll?.roll_id ?? event.payload?.roll_id ?? null,
      total: event.payload?.roll?.total ?? event.payload?.total ?? null,
      difficulty: event.payload?.roll?.difficulty ?? event.payload?.difficulty ?? null,
      kept: event.payload?.roll?.kept ?? event.payload?.kept ?? null,
    }))
  return {
    commit_count: commits.length,
    event_count: events.length,
    commit_idempotency_keys: commits.map((commit) => commit.idempotency_key),
    commit_state_versions: commits.map((commit) => [commit.state_version_before, commit.state_version_after]),
    event_types: events.map((event) => event.event_type),
    rolls,
    state_version: state?.state_version ?? null,
    world_time_minutes: state?.mechanics?.world_time?.elapsed_minutes ?? null,
  }
}

async function roomState(baseUrl, code, cookie) {
  const result = await request(baseUrl, `/api/rooms/${code}`, { cookie })
  assert.equal(result.status, 200, result.text)
  return result.body?.state ?? null
}

async function bootstrap({ code, backendUrl }) {
  const setupToken = `${code}-setup-token`
  const setup = await request(backendUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Probe Admin', email: `${code.toLowerCase()}-admin@example.test`, password: 'probe-admin-password', setupToken },
  })
  assert.equal(setup.status, 201, setup.text)
  assert.ok(setup.cookie)
  const created = await request(backendUrl, '/api/campaigns', {
    method: 'POST', cookie: setup.cookie,
    body: { code, name: 'Narrate retry probe', state: baseState(code) },
  })
  assert.equal(created.status, 201, created.text)
  const registered = await request(backendUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Probe Player', email: `${code.toLowerCase()}-player@example.test`, password: 'probe-player-password' },
  })
  assert.equal(registered.status, 201, registered.text)
  assert.ok(registered.cookie)
  const users = await request(backendUrl, '/api/admin/users', { cookie: setup.cookie })
  assert.equal(users.status, 200, users.text)
  const player = users.body?.users?.find((candidate) => candidate.email === `${code.toLowerCase()}-player@example.test`)
  assert.ok(player)
  const assigned = await request(backendUrl, `/api/admin/users/${player.id}`, {
    method: 'PATCH', cookie: setup.cookie, body: { heroIds: ['hero-a'] },
  })
  assert.equal(assigned.status, 200, assigned.text)
  return { cookie: registered.cookie, state: { sessionCode: code } }
}

async function compileClient() {
  const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-narrate-retry-client-'))
  const compiled = spawnSync(process.execPath, [
    compiler,
    '--ignoreConfig',
    '--target', 'ES2022',
    '--module', 'ESNext',
    '--moduleResolution', 'Bundler',
    '--lib', 'ES2022,DOM',
    '--strict',
    '--skipLibCheck',
    '--outDir', buildDir,
    join(root, 'src', 'ai-client.ts'),
  ], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
  const compiledPath = join(buildDir, 'ai-client.mjs')
  renameSync(join(buildDir, 'ai-client.js'), compiledPath)
  const client = await import(pathToFileURL(compiledPath).href)
  return { client, buildDir }
}

async function runScenario({ client, code, failureMode, explicitKey = undefined }) {
  const backendPort = await freePort()
  const proxyPort = await freePort()
  const storage = mkdtempSync(join(tmpdir(), `skazanie-narrate-retry-${code.toLowerCase()}-`))
  const backendUrl = `http://127.0.0.1:${backendPort}`
  const proxyUrl = `http://127.0.0.1:${proxyPort}`
  const backend = startBackend({ port: backendPort, storage, setupToken: `${code}-setup-token` })
  let proxy = null
  const originalFetch = globalThis.fetch
  try {
    await waitForHealth(backendUrl, backend.child, backend.logs)
    const identity = await bootstrap({ code, backendUrl })
    proxy = await startProxy({ port: proxyPort, backendUrl, failureMode })
    const nativeFetch = originalFetch
    globalThis.fetch = (input, init = {}) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const target = raw.startsWith('/') ? `${proxyUrl}${raw}` : raw
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
      headers.set('Cookie', identity.cookie)
      return nativeFetch(target, { ...init, headers })
    }
    const call = () => explicitKey === undefined
      ? client.narrateWithAgent(identity.state, action, 'Герой', undefined, undefined, 'hero-a')
      : client.narrateWithAgent(identity.state, action, 'Герой', undefined, explicitKey, 'hero-a')
    let firstError = null
    let firstResult = null
    try { firstResult = await call() } catch (error) {
      firstError = {
        name: error?.name ?? null,
        status: error?.status ?? null,
        code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 180),
      }
    }
    const afterFirstState = await roomState(backendUrl, code, identity.cookie)
    const afterFirst = ledger(storage, afterFirstState)
    let secondError = null
    let secondResult = null
    try { secondResult = await call() } catch (error) {
      secondError = {
        name: error?.name ?? null,
        status: error?.status ?? null,
        code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 180),
      }
    }
    const afterSecondState = await roomState(backendUrl, code, identity.cookie)
    const afterSecond = ledger(storage, afterSecondState)
    return {
      failure_mode: failureMode ?? 'none',
      first: {
        error: firstError,
        result: firstResult ? { idempotent_replay: Boolean(firstResult.idempotent_replay), turn_consumed: firstResult.turn_consumed ?? null } : null,
        ledger: afterFirst,
      },
      second: {
        error: secondError,
        result: secondResult ? { idempotent_replay: Boolean(secondResult.idempotent_replay), turn_consumed: secondResult.turn_consumed ?? null } : null,
        ledger: afterSecond,
      },
      proxy: { narrate_keys: proxy.state.keys, keys_equal: proxy.state.keys.length >= 2 && proxy.state.keys[0] === proxy.state.keys[1] },
    }
  } finally {
    globalThis.fetch = originalFetch
    if (proxy) await new Promise((resolve) => proxy.proxy.close(() => resolve()))
    await stopChild(backend.child, backend.logs)
    rmSync(storage, { recursive: true, force: true })
  }
}

globalThis.window = { localStorage: { getItem: (key) => key === 'skazanie-auto-attack-roll' ? 'true' : null } }
const { client, buildDir } = await compileClient()
try {
  const status503 = await runScenario({ client, code: 'NARRATE-503', failureMode: '503' })
  const drop = await runScenario({ client, code: 'NARRATE-DROP', failureMode: 'drop' })
  const sameKey = await runScenario({ client, code: 'NARRATE-SAME', failureMode: null, explicitKey: 'same-semantic-key' })
  const sameKeyAfter503 = await runScenario({ client, code: 'NARRATE-SAME-503', failureMode: '503', explicitKey: 'same-after-503-key' })

  assert.equal(status503.first.error?.status, 503)
  assert.equal(status503.first.ledger.commit_count, 1)
  assert.equal(status503.second.error, null)
  assert.equal(status503.second.ledger.commit_count, 2)
  assert.equal(status503.second.ledger.rolls.length, 2)
  assert.notEqual(status503.second.ledger.rolls[0].roll_id, status503.second.ledger.rolls[1].roll_id)
  assert.equal(status503.proxy.keys_equal, false)
  assert.equal(drop.first.error?.status, null)
  assert.equal(drop.first.error?.name, 'TypeError')
  assert.equal(drop.first.ledger.commit_count, 1)
  assert.equal(drop.second.error, null)
  assert.equal(drop.second.ledger.commit_count, 2)
  assert.equal(drop.second.ledger.rolls.length, 2)
  assert.notEqual(drop.second.ledger.rolls[0].roll_id, drop.second.ledger.rolls[1].roll_id)
  assert.equal(drop.proxy.keys_equal, false)
  assert.equal(sameKey.first.error, null)
  assert.equal(sameKey.second.error, null)
  assert.equal(sameKey.first.ledger.commit_count, 1)
  assert.equal(sameKey.second.ledger.commit_count, 1)
  assert.equal(sameKey.second.ledger.rolls.length, 1)
  assert.equal(sameKey.second.result?.idempotent_replay, true)
  assert.equal(sameKey.proxy.keys_equal, true)
  assert.equal(sameKeyAfter503.first.error?.status, 503)
  assert.equal(sameKeyAfter503.first.ledger.commit_count, 1)
  assert.equal(sameKeyAfter503.second.error, null)
  assert.equal(sameKeyAfter503.second.ledger.commit_count, 1)
  assert.equal(sameKeyAfter503.second.ledger.rolls.length, 1)
  assert.equal(sameKeyAfter503.second.result?.idempotent_replay, true)
  assert.equal(sameKeyAfter503.proxy.keys_equal, true)

  process.stdout.write(JSON.stringify({
    ok: true,
    action,
    auto_roll_fixture: 'window.localStorage[skazanie-auto-attack-roll]=true',
    scenarios: {
      status503,
      drop,
      same_key_control: sameKey,
      same_key_after_503: sameKeyAfter503,
    },
  }, null, 2) + '\n')
} finally {
  delete globalThis.window
  rmSync(buildDir, { recursive: true, force: true })
}

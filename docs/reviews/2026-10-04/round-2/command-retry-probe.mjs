import assert from 'node:assert/strict'
import { createServer as createNetServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
const storage = mkdtempSync(join(tmpdir(), 'skazanie-command-retry-'))
const emptyEnvPath = join(storage, 'empty.env')
writeFileSync(emptyEnvPath, '', 'utf8')
const setupToken = 'command-retry-probe-token'
const MAX_LOG_CHARS = 4_000
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
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
let logs = ''
const appendLog = (chunk) => { logs = `${logs}${String(chunk)}`.slice(-MAX_LOG_CHARS) }
child.stdout.on('data', appendLog)
child.stderr.on('data', appendLog)

async function stopChild() {
  if (child.exitCode != null || child.signalCode != null) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not stop\n${logs.slice(-MAX_LOG_CHARS)}`)), 5_000)
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

async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited: ${child.exitCode}\n${logs.slice(-MAX_LOG_CHARS)}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* слушатель ещё запускается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`server did not become healthy\n${logs.slice(-MAX_LOG_CHARS)}`)
}

async function request(path, { method = 'GET', cookie = '', body } = {}) {
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

function commandBody(idempotencyKey, message, command) {
  return { idempotency_key: idempotencyKey, message, command }
}

function eventBrief(result) {
  return (result?.body?.mechanics ?? []).map((event) => ({
    event_type: event.event_type,
    actor_id: event.actor_id ?? null,
    target_ids: event.target_ids ?? [],
    payload: event.payload ?? null,
  }))
}

function responseBrief(result) {
  return {
    status: result.status,
    code: result.body?.code ?? null,
    error: typeof result.body?.error === 'string' ? result.body.error.slice(0, 240) : null,
    idempotent_replay: result.body?.idempotent_replay ?? null,
  }
}

const state = {
  sessionCode: 'RETRY-PROBE',
  campaign: 'Idempotency probe',
  activePlayerId: 'hero-a',
  isNarrating: false,
  pendingCheck: null,
  suggestions: [],
  messages: [],
  players: [
    { id: 'hero-a', character: 'A', hp: 10, maxHp: 10, armor: 12, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, proficiency: 2, inventory: [], online: true },
    { id: 'hero-b', character: 'B', hp: 10, maxHp: 10, armor: 12, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, proficiency: 2, inventory: [], online: true },
  ],
  enemies: [
    { id: 'goblin-a', character: 'Goblin A', hp: 10, maxHp: 10, armor: 10, abilities: { str: 8, dex: 10, con: 10, int: 8, wis: 8, cha: 8 }, proficiency: 2, inventory: [], alive: true },
    { id: 'goblin-b', character: 'Goblin B', hp: 10, maxHp: 10, armor: 10, abilities: { str: 8, dex: 10, con: 10, int: 8, wis: 8, cha: 8 }, proficiency: 2, inventory: [], alive: true },
    { id: 'goblin-c', character: 'Goblin C', hp: 10, maxHp: 10, armor: 10, abilities: { str: 8, dex: 10, con: 10, int: 8, wis: 8, cha: 8 }, proficiency: 2, inventory: [], alive: true },
  ],
  scene: { title: 'Probe', location: 'Probe', mood: '', objective: '', turn: 0, cells: [] },
  social: { npcs: [], relationships: {}, conversations: [], promises: [] },
  ruleset_id: 'srd_5_2_1',
  ruleset_version: '5.2.1',
  enabled_rule_packs: ['srd_5_2_1'],
  engine_mode: 'enforce',
  state_version: 0,
}

try {
  await waitForHealth()
  const setup = await request('/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Probe Admin', email: 'command-retry-probe@example.test', password: 'command-retry-probe-password', setupToken },
  })
  assert.equal(setup.status, 201, setup.text)
  const cookie = setup.cookie
  assert.ok(cookie, 'setup must return a session cookie')
  const campaign = await request('/api/campaigns', {
    method: 'POST', cookie,
    body: { code: state.sessionCode, name: state.campaign, state },
  })
  assert.equal(campaign.status, 201, campaign.text)

  const registered = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Probe Player', email: 'command-retry-player@example.test', password: 'command-retry-player-password' },
  })
  assert.equal(registered.status, 201, registered.text)
  const users = await request('/api/admin/users', { cookie })
  const player = users.body?.users?.find((candidate) => candidate.email === 'command-retry-player@example.test')
  assert.ok(player)
  const assigned = await request(`/api/admin/users/${player.id}`, {
    method: 'PATCH', cookie,
    body: { heroIds: ['hero-a', 'hero-b'] },
  })
  assert.equal(assigned.status, 200, assigned.text)
  const playerCookie = registered.cookie
  assert.ok(playerCookie, 'player registration must return a session cookie')

  const firstCommand = { command_type: 'IdentifyEnemy', actor_id: 'hero-a', target_id: 'goblin-a' }
  const changedCommand = { ...firstCommand, target_id: 'goblin-b' }
  const first = await request(`/api/campaigns/${state.sessionCode}/commands`, {
    method: 'POST', cookie: playerCookie,
    body: commandBody('same-command-key', 'same message', firstCommand),
  })
  assert.equal(first.status, 200, first.text)
  const changed = await request(`/api/campaigns/${state.sessionCode}/commands`, {
    method: 'POST', cookie: playerCookie,
    body: commandBody('same-command-key', 'same message', changedCommand),
  })

  const crossEndpoint = await request(`/api/campaigns/${state.sessionCode}/commands`, {
    method: 'POST', cookie: playerCookie,
    body: commandBody('cross-endpoint-key', 'Атакую goblin-b', { ...firstCommand, target_id: 'goblin-b' }),
  })
  const crossEndpointReplay = await request('/api/narrate', {
    method: 'POST', cookie: playerCookie,
    body: { campaignId: state.sessionCode, actor_id: 'hero-a', action: 'Атакую goblin-b', idempotency_key: 'cross-endpoint-key' },
  })

  const crossActorCommand = { ...firstCommand, target_id: 'goblin-c' }
  const crossActor = await request(`/api/campaigns/${state.sessionCode}/commands`, {
    method: 'POST', cookie: playerCookie,
    body: commandBody('cross-actor-key', 'actor message', crossActorCommand),
  })
  const crossActorReplay = await request(`/api/campaigns/${state.sessionCode}/commands`, {
    method: 'POST', cookie: playerCookie,
    body: commandBody('cross-actor-key', 'actor message', { ...crossActorCommand, actor_id: 'hero-b' }),
  })

  assert.equal(changed.status, 200)
  assert.equal(changed.body?.idempotent_replay, true)
  assert.deepEqual(eventBrief(changed), eventBrief(first), 'изменённая команда не должна менять replay-события')
  assert.equal(crossEndpoint.status, 200)
  assert.equal(crossEndpointReplay.status, 200)
  assert.equal(crossEndpointReplay.body?.idempotent_replay, true)
  assert.deepEqual(eventBrief(crossEndpointReplay), eventBrief(crossEndpoint), 'другой endpoint не должен незаметно подменять commit')
  assert.equal(crossActor.status, 200, JSON.stringify(responseBrief(crossActor)))
  assert.equal(crossActorReplay.status, 409, JSON.stringify(responseBrief(crossActorReplay)))
  assert.equal(crossActorReplay.body?.code, 'IDEMPOTENCY_CONFLICT', JSON.stringify(responseBrief(crossActorReplay)))

  const evidence = {
    changed_command: {
      first: responseBrief(first),
      retry: responseBrief(changed),
      first_events: eventBrief(first),
      retry_events: eventBrief(changed),
    },
    cross_endpoint: {
      commands: responseBrief(crossEndpoint),
      narrate: responseBrief(crossEndpointReplay),
      commands_events: eventBrief(crossEndpoint),
      narrate_events: eventBrief(crossEndpointReplay),
    },
    cross_actor: {
      first: responseBrief(crossActor),
      retry: responseBrief(crossActorReplay),
    },
  }
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await stopChild()
  rmSync(storage, { recursive: true, force: true })
}

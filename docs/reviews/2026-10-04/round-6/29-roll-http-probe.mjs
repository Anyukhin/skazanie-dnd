import assert from 'node:assert/strict'
import { createServer as createNetServer } from 'node:net'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const SESSION = 'ROLL-HTTP'
const SETUP_TOKEN = 'roll-http-probe-setup'
const ACTION = 'Проверяю силу'

async function freePort() {
  const server = createNetServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

function fixtureState() {
  return {
    state_version: 0,
    sessionCode: SESSION,
    campaign: 'HTTP roll binding probe',
    activePlayerId: 'hero-a',
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [{
      id: 'hero-a', character: 'Герой', name: 'Герой', hp: 10, maxHp: 10,
      armor: 14, proficiency: 2,
      abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
      inventory: [], online: true,
    }],
    enemies: [],
    scene: { title: 'Проба', location: 'Площадь', mood: '', objective: '', turn: 0, cells: [] },
    mechanics: { world_time: { elapsed_minutes: 0 } },
    social: { npcs: [], relationships: {}, conversations: [], promises: [] },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce',
  }
}

function startServer(port, storage, emptyEnv, logs) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      DOTENV_CONFIG_PATH: emptyEnv, ROUTERAI_API_KEY: '', ROUTERAI_BASE_URL: '',
      ADMIN_SETUP_TOKEN: SETUP_TOKEN, GAME_ENGINE_MODE: 'enforce', COOKIE_SECURE: 'false', NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const capture = (chunk) => { logs.push(String(chunk)) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
  if (child.exitCode == null) child.kill('SIGKILL')
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited before health: ${logs.join('').slice(-2_000)}`)
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return
    } catch { /* Ждём запуска своего сервера. */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`server did not become healthy: ${logs.join('').slice(-2_000)}`)
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
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* Сохраняем исходный текст для диагностики. */ }
  return { status: response.status, body: parsed, text, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' }
}

function requireStatus(result, status, label) {
  assert.equal(result.status, status, `${label}: ${result.text}`)
  return result
}

function eventLedger(storage) {
  const campaignsRoot = join(storage, 'engine', 'campaigns')
  const campaignDir = readdirSync(campaignsRoot, { withFileTypes: true }).find((entry) => entry.isDirectory())
  assert.ok(campaignDir, 'event campaign directory should exist')
  const eventsDir = join(campaignsRoot, campaignDir.name, 'events')
  const commits = readdirSync(eventsDir).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(readFileSync(join(eventsDir, name), 'utf8')))
  const events = commits.flatMap((commit) => commit.events ?? [])
  return {
    commit_count: commits.length,
    commit_idempotency_keys: commits.map((commit) => commit.idempotency_key),
    state_version_ranges: commits.map((commit) => [commit.state_version_before, commit.state_version_after]),
    event_types: events.map((event) => event.event_type),
    ability_checks: events.filter((event) => event.event_type === 'AbilityCheckResolved').map((event) => ({
      roll_id: event.payload?.roll_id ?? event.payload?.roll?.roll_id ?? null,
      kept: event.payload?.kept ?? event.payload?.roll?.kept ?? null,
      total: event.payload?.total ?? event.payload?.roll?.total ?? null,
      difficulty: event.payload?.difficulty ?? event.payload?.roll?.difficulty ?? null,
      player_rolled: event.payload?.player_rolled ?? null,
    })),
  }
}

async function run() {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-roll-http-'))
  const emptyEnv = join(storage, 'empty.env')
  writeFileSync(emptyEnv, '', 'utf8')
  const logs = []
  let child = null
  try {
    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    child = startServer(port, storage, emptyEnv, logs)
    await waitForHealth(baseUrl, child, logs)

    const admin = requireStatus(await request(baseUrl, '/api/auth/setup-admin', {
      method: 'POST',
      body: { name: 'Probe admin', email: 'roll-http-admin@example.test', password: 'probe-admin-password', setupToken: SETUP_TOKEN },
    }), 201, 'setup admin')
    const adminCookie = admin.cookie
    assert.ok(adminCookie)
    requireStatus(await request(baseUrl, '/api/campaigns', {
      method: 'POST', cookie: adminCookie,
      body: { code: SESSION, name: 'HTTP roll binding probe', state: fixtureState() },
    }), 201, 'create fixture campaign')
    const player = requireStatus(await request(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { name: 'Probe player', email: 'roll-http-player@example.test', password: 'probe-player-password' },
    }), 201, 'register player')
    assert.ok(player.body?.user?.id)
    const playerCookie = player.cookie
    const users = requireStatus(await request(baseUrl, '/api/admin/users', { cookie: adminCookie }), 200, 'list users')
    const playerUser = users.body.users.find((candidate) => candidate.email === 'roll-http-player@example.test')
    assert.ok(playerUser)
    requireStatus(await request(baseUrl, `/api/admin/users/${playerUser.id}`, {
      method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero-a'] },
    }), 200, 'assign hero')

    const offer = requireStatus(await request(baseUrl, '/api/narrate', {
      method: 'POST', cookie: playerCookie,
      body: { campaignId: SESSION, actor_id: 'hero-a', action: ACTION, manual_roll: true, idempotency_key: 'http-generic-offer' },
    }), 200, 'ordinary ability-check offer')
    assert.ok(offer.body?.check?.check_id, `offer has no check: ${offer.text}`)
    assert.equal(offer.body.mechanics?.length, 0)
    const checkId = offer.body.check.check_id

    const missingCheck = await request(baseUrl, '/api/roll', {
      method: 'POST', cookie: playerCookie,
      body: { campaignId: SESSION, playerId: 'hero-a', checkId: 'missing-check-id' },
    })
    assert.equal(missingCheck.status, 400)
    const missingCheckError = missingCheck.body?.error ?? null

    const wrongActor = await request(baseUrl, '/api/roll', {
      method: 'POST', cookie: playerCookie,
      body: { campaignId: SESSION, playerId: 'hero-b' },
    })
    assert.equal(wrongActor.status, 403)
    const wrongActorError = wrongActor.body?.error ?? null

    const genericRolls = []
    for (let index = 0; index < 3; index += 1) {
      const rolled = requireStatus(await request(baseUrl, '/api/roll', {
        method: 'POST', cookie: playerCookie,
        // Намеренно без checkId/check_id: проверяем отсутствие привязки.
        body: { campaignId: SESSION, playerId: 'hero-a' },
      }), 200, `generic roll ${index + 1}`)
      assert.ok(rolled.body.roll_id)
      assert.equal(Number.isInteger(rolled.body.value), true)
      genericRolls.push({ roll_id: rolled.body.roll_id, kept: rolled.body.value, total: rolled.body.total, difficulty: rolled.body.difficulty })
    }
    const selected = genericRolls.reduce((best, current) => current.kept > best.kept ? current : best)
    const resolved = requireStatus(await request(baseUrl, '/api/narrate', {
      method: 'POST', cookie: playerCookie,
      body: { campaignId: SESSION, actor_id: 'hero-a', action: ACTION, roll: { roll_id: selected.roll_id }, idempotency_key: 'http-generic-resolve' },
    }), 200, 'ordinary action with unbound roll')
    const ability = (resolved.body.mechanics ?? []).find((event) => event.event_type === 'AbilityCheckResolved')
    assert.ok(ability, `no AbilityCheckResolved: ${resolved.text}`)
    assert.equal(ability.payload.roll_id, selected.roll_id)
    assert.equal(ability.payload.kept, selected.kept)
    assert.equal(ability.payload.player_rolled, true)

    const replay = requireStatus(await request(baseUrl, '/api/narrate', {
      method: 'POST', cookie: playerCookie,
      body: { campaignId: SESSION, actor_id: 'hero-a', action: ACTION, roll: { roll_id: selected.roll_id }, idempotency_key: 'http-generic-resolve' },
    }), 200, 'same-key replay')
    assert.equal(replay.body.idempotent_replay, true)
    const reused = await request(baseUrl, '/api/narrate', {
      method: 'POST', cookie: playerCookie,
      body: { campaignId: SESSION, actor_id: 'hero-a', action: ACTION, roll: { roll_id: selected.roll_id }, idempotency_key: 'http-generic-reuse' },
    })
    assert.equal(reused.status, 400)
    const reusedError = reused.body?.error ?? null

    const room = requireStatus(await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: playerCookie }), 200, 'read authoritative room')
    const ledger = eventLedger(storage)
    assert.equal(ledger.ability_checks.length, 1)
    assert.equal(room.body.state.state_version, resolved.body.authoritative_state.state_version)
    process.stdout.write(JSON.stringify({
      ok: true,
      baseline: '88c620e6011ae607913efb224cb8f850b4ee5028',
      action: ACTION,
      check_card: { check_id: checkId, difficulty: offer.body.check.difficulty, modifier: offer.body.check.modifier },
      generic_rolls: genericRolls,
      selected_roll: selected,
      accepted: {
        status: resolved.status,
        roll_id: ability.payload.roll_id,
        kept: ability.payload.kept,
        total: ability.payload.total,
        difficulty: ability.payload.difficulty,
        player_rolled: ability.payload.player_rolled,
        idempotent_replay: replay.body.idempotent_replay,
      },
      controls: {
        missing_check: { status: missingCheck.status, error: missingCheckError },
        wrong_actor: { status: wrongActor.status, error: wrongActorError },
        reused_roll_new_key: { status: reused.status, error: reusedError },
      },
      authoritative_room: { state_version: room.body.state.state_version, session_code: room.body.state.sessionCode },
      events: ledger,
    }, null, 2) + '\n')
  } finally {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})

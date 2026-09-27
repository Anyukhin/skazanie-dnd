import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const port = probe.address().port
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

function startServer({ port, storage, setupToken, appendLog }) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: setupToken,
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
    const timer = setTimeout(() => reject(new Error('HTTP test server did not stop')), 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* assertion below reports text */ }
  return { status: response.status, body: parsed, text, response }
}

function sessionCookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

async function waitForHealth(baseUrl, child, log) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`HTTP server exited: ${child.exitCode}\n${log()}`)
    try {
      const result = await request(baseUrl, '/api/health')
      if (result.status === 200) return
    } catch { /* listener is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`HTTP server did not become healthy\n${log()}`)
}

function cells() {
  return Array.from({ length: 25 }, (_, index) => ({
    x: index % 5, y: Math.floor(index / 5), type: 'floor', revealed: true,
  }))
}

test('обычный HTTP путь позволяет владельцу героя наложить Protection from Energy на себя', { timeout: 30_000 }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-pfe-http-'))
  const setupToken = 'pfe-http-setup-token'
  let logs = ''
  let child = null
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const log = () => logs
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })

  child = startServer({ port, storage, setupToken, appendLog: (chunk) => { logs += chunk } })
  await waitForHealth(baseUrl, child, log)
  const setup = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'PFE admin', email: 'pfe-admin@test.invalid', password: 'pfe-admin-password', setupToken,
  } })
  assert.equal(setup.status, 201, `${setup.text}\n${log()}`)
  const adminCookie = sessionCookie(setup)
  const registration = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'PFE player', email: 'pfe-player@test.invalid', password: 'pfe-player-password',
  } })
  assert.equal(registration.status, 201, `${registration.text}\n${log()}`)
  const playerCookie = sessionCookie(registration)
  const state = {
    sessionCode: 'PFE-HTTP', campaign: 'Protection from energy HTTP', partyMemberIds: ['caster', 'ally'], activePlayerId: 'caster',
    ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    players: [
      { id: 'caster', name: 'Мира', character: 'Мира', characterClass: 'wizard', level: 5, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3, abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory: [], knownSpellIds: ['protection-from-energy'], preparedSpellIds: ['protection-from-energy'], x: 1, y: 1 },
      { id: 'ally', name: 'Бор', character: 'Бор', characterClass: 'fighter', level: 5, hp: 40, maxHp: 40, armor: 14, speed: 30, proficiency: 3, abilities: { str: 16, dex: 12, con: 14 }, inventory: [], x: 2, y: 1 },
    ],
    enemies: [], scene: { title: 'PFE HTTP', location: 'test', turn: 1, cells: cells() },
    mechanics: { resources: { caster: { spell_slots_3: { current: 2, max: 2 } } }, combat: { active: false } }, engine_mode: 'enforce',
  }
  const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: adminCookie, body: { code: 'PFE-HTTP', name: state.campaign, state } })
  assert.equal(created.status, 201, `${created.text}\n${log()}`)
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const player = users.body.users.find((candidate) => candidate.email === 'pfe-player@test.invalid')
  const assigned = await request(baseUrl, `/api/admin/users/${player.id}`, { method: 'PATCH', cookie: adminCookie, body: { heroIds: ['caster'] } })
  assert.equal(assigned.status, 200, `${assigned.text}\n${log()}`)

  const command = { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'protection-from-energy', target_id: 'caster', spell_option: 'fire' }
  const first = await request(baseUrl, '/api/campaigns/PFE-HTTP/commands', { method: 'POST', cookie: playerCookie, body: { idempotency_key: 'pfe-http-cast', message: 'Защищаюсь от огня', command } })
  assert.equal(first.status, 200, `${first.text}\n${log()}`)
  const condition = first.body.mechanics.find((event) => event.event_type === 'ConditionAdded')
  assert.equal(condition.payload.condition, 'protected-from-energy:fire')
  assert.equal(condition.payload.expiry_policy, 'protection-from-energy/v1')
  assert.equal(first.body.authoritative_state.mechanics.resources.caster.spell_slots_3.current, 1)

  const duplicate = await request(baseUrl, '/api/campaigns/PFE-HTTP/commands', { method: 'POST', cookie: playerCookie, body: { idempotency_key: 'pfe-http-cast', message: 'Защищаюсь от огня', command } })
  assert.equal(duplicate.status, 200, `${duplicate.text}\n${log()}`)
  assert.equal(duplicate.body.idempotent_replay, true)
  assert.equal(duplicate.body.authoritative_state.state_version, first.body.authoritative_state.state_version)
})

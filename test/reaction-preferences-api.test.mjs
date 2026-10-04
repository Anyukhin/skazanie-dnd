import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { freePort } from './free-port.mjs'
import { buildCombatLabState } from '../server/combat-lab-setup.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const CAMPAIGN = 'REACTION-MODES-HTTP'
const SETUP_TOKEN = 'reaction-modes-test-admin'

async function harness(t) {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-reaction-modes-api-'))
  let child = null
  let baseUrl = ''
  let logs = ''
  const stop = async () => {
    if (!child || child.exitCode != null || child.signalCode != null) return
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Тестовый сервер не завершился')), 5_000)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
      child.kill()
    })
  }
  t.after(async () => {
    await stop()
    rmSync(storage, { recursive: true, force: true })
  })
  const start = async () => {
    const port = await freePort()
    baseUrl = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: process.cwd(), env: { ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port),
        DND_STORAGE_DIR: storage, ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: SETUP_TOKEN,
        COOKIE_SECURE: 'false', NODE_ENV: 'test', DND_COMBAT_TURN_TIMEOUT_MS: '3600000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-3_000) })
    child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-3_000) })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode != null || child.signalCode != null) throw new Error(`Сервер: exit=${child.exitCode}, signal=${child.signalCode}\n${logs}`)
      try { if ((await fetch(`${baseUrl}/api/health`)).ok) return } catch { /* запуск слушателя */ }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Сервер не запустился\n${logs}`)
  }
  const request = async (path, { cookie = '', method = 'GET', body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { method, signal: AbortSignal.timeout(30_000),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  await start()
  return { request, restart: async () => { await stop(); await start() } }
}

function expect(result, status = 200) {
  assert.equal(result.status, status, JSON.stringify({ code: result.body.code, error: result.body.error }))
  return result.body
}

test('HTTP: игрок задаёт режим реакции только своему герою, повтор и restart не меняют результат', { timeout: runnerTimeout(90_000) }, async (t) => {
  const api = await harness(t)
  const admin = expect(await api.request('/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Ведущий', email: 'gm@reaction-modes.test', password: 'reaction-modes-admin-password', setupToken: SETUP_TOKEN,
  } }), 201)
  void admin
  const gm = (await api.request('/api/auth/login', { method: 'POST', body: { email: 'gm@reaction-modes.test', password: 'reaction-modes-admin-password' } })).cookie
  const state = await buildCombatLabState({
    mapId: 'forest-clearing',
    party: [
      { source: 'class', classId: 'wizard', level: 5, x: 1, y: 4 },
      { source: 'class', classId: 'rogue', level: 5, x: 1, y: 5 },
    ],
    enemies: [{ monsterId: 'dnd_5e_2014:monster:orc', x: 7, y: 8 }],
  })
  state.sessionCode = CAMPAIGN
  const created = await api.request('/api/campaigns', { method: 'POST', cookie: gm, body: { code: CAMPAIGN, name: 'Режимы реакций', state } })
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body).slice(0, 300))
  const invite = expect(await api.request(`/api/campaigns/${CAMPAIGN}/invites`, { method: 'POST', cookie: gm, body: { hero_ids: ['hero-2'] } }), 201)
  const player = expect(await api.request('/api/auth/register', { method: 'POST', body: {
    name: 'Плут', email: 'rogue@reaction-modes.test', password: 'reaction-modes-player-password',
  } }), 201)
  void player
  const rogue = (await api.request('/api/auth/login', { method: 'POST', body: { email: 'rogue@reaction-modes.test', password: 'reaction-modes-player-password' } })).cookie
  expect(await api.request(`/api/campaigns/${CAMPAIGN}/join`, { method: 'POST', cookie: rogue, body: { invite_token: invite.token } }))

  const command = (cookie, key, body) => api.request(`/api/campaigns/${CAMPAIGN}/commands`, { method: 'POST', cookie, body: { idempotency_key: key, command: body } })
  const room = async (cookie) => expect(await api.request(`/api/rooms/${CAMPAIGN}`, { cookie })).state

  // Свой герой видит свои реакции списком с режимами; «Невероятное уклонение»
  // плута 5-го уровня — из того же серверного перечня, что сверяет команда.
  const before = await room(rogue)
  const ownHero = before.players.find((hero) => hero.id === 'hero-2')
  assert.deepEqual(ownHero.reactionModes.map((entry) => `${entry.id}:${entry.mode}`), ['opportunity-attack:ask', 'uncanny-dodge:ask'])
  assert.equal(before.players.find((hero) => hero.id === 'hero-1').reactionModes, undefined)

  const foreign = await command(rogue, 'foreign-mode', { command_type: 'SetReactionPreference', actor_id: 'hero-1', reaction_id: 'opportunity-attack', mode: 'never' })
  expect(foreign, 403)
  const invalid = await command(rogue, 'invalid-mode', { command_type: 'SetReactionPreference', actor_id: 'hero-2', reaction_id: 'cast:shield', mode: 'auto' })
  expect(invalid, 400)
  assert.equal(invalid.body.code, 'REACTION_PREFERENCE_INVALID')

  const set = expect(await command(rogue, 'rogue-dodge-auto', { command_type: 'SetReactionPreference', actor_id: 'hero-2', reaction_id: 'uncanny-dodge', mode: 'auto' }))
  const repeated = expect(await command(rogue, 'rogue-dodge-auto', { command_type: 'SetReactionPreference', actor_id: 'hero-2', reaction_id: 'uncanny-dodge', mode: 'auto' }))
  assert.equal(repeated.idempotent_replay, true, 'повтор с тем же ключом возвращает прежний commit')
  assert.deepEqual(repeated.mechanics.map((event) => event.event_type), set.mechanics.map((event) => event.event_type))
  assert.equal(set.mechanics.filter((event) => event.event_type === 'ReactionPreferenceChanged').length, 1)

  const after = await room(rogue)
  assert.equal(after.players.find((hero) => hero.id === 'hero-2').reactionModes.find((entry) => entry.id === 'uncanny-dodge').mode, 'auto')
  assert.deepEqual(after.mechanics.reaction_preferences, { 'hero-2': { 'uncanny-dodge': 'auto' } })

  await api.restart()
  const restarted = await room(rogue)
  assert.equal(restarted.players.find((hero) => hero.id === 'hero-2').reactionModes.find((entry) => entry.id === 'uncanny-dodge').mode, 'auto', 'режим пережил перезапуск сервера')
})

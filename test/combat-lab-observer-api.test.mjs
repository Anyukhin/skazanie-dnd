import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildCombatLabState } from '../server/combat-lab-setup.mjs'

import { runnerTimeout } from './shared-runner-timeout.mjs'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

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

function startServer({ port, storage, setupToken, appendLog }) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ROUTERAI_BASE_URL: '',
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
    const timer = setTimeout(() => reject(new Error('Сервер стенда не остановился')), 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Сервер стенда завершился\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* сервер ещё запускается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Сервер стенда не стал доступен\n${logs()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* проверка ниже покажет исходный ответ */ }
  return { status: response.status, body: parsed, text, response }
}

function cookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

async function waitForRun(baseUrl, adminCookie, id, predicate) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const result = await request(baseUrl, `/api/admin/combat-lab/runs/${id}`, { cookie: adminCookie })
    assert.equal(result.status, 200, result.text)
    if (predicate(result.body)) return result.body
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Прогон ${id} не достиг ожидаемого состояния`)
}

test('админ наблюдает асинхронный боевой стенд через HTTP', { timeout: runnerTimeout(90_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-combat-lab-observer-'))
  const setupToken = 'combat-lab-observer-setup-token'
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, setupToken, appendLog: (chunk) => { logs += chunk } })
  await waitForHealth(baseUrl, child, () => logs)

  const unauthenticated = await request(baseUrl, '/api/admin/combat-lab/scenarios')
  assert.equal(unauthenticated.status, 401, unauthenticated.text)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Наблюдатель', email: 'observer-admin@combat-lab.test', password: 'observer-admin-password', setupToken },
  })
  assert.equal(setup.status, 201, setup.text)
  const adminCookie = cookie(setup)

  const player = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Игрок', email: 'observer-player@combat-lab.test', password: 'observer-player-password' },
  })
  assert.equal(player.status, 201, player.text)
  const playerCookie = cookie(player)

  const playerDenied = await request(baseUrl, '/api/admin/combat-lab/scenarios', { cookie: playerCookie })
  assert.equal(playerDenied.status, 403, playerDenied.text)
  const playerCatalogDenied = await request(baseUrl, '/api/admin/combat-lab/catalog', { cookie: playerCookie })
  assert.equal(playerCatalogDenied.status, 403, playerCatalogDenied.text)
  const playerRunDenied = await request(baseUrl, '/api/admin/combat-lab/runs', {
    method: 'POST', cookie: playerCookie, body: { scenario: 'missing', seed: 1 },
  })
  assert.equal(playerRunDenied.status, 403, playerRunDenied.text)

  const scenarios = await request(baseUrl, '/api/admin/combat-lab/scenarios', { cookie: adminCookie })
  assert.equal(scenarios.status, 200, scenarios.text)
  assert.ok(scenarios.body.scenarios.some((entry) => entry.id === 'duel' && entry.name))
  const catalog = await request(baseUrl, '/api/admin/combat-lab/catalog', { cookie: adminCookie })
  assert.equal(catalog.status, 200, catalog.text)
  assert.equal(catalog.body.limits.party, 6)
  assert.ok(catalog.body.classes.some((entry) => entry.id === 'fighter'))
  assert.ok(catalog.body.monsters.every((entry) => entry.id.startsWith('dnd_5e_2014:')))
  assert.ok(catalog.body.maps.length >= 4 && catalog.body.maps.every((entry) => entry.map && entry.cells.length > 0))
  const sourceState = await buildCombatLabState({ mapId: 'open-courtyard',
    party: [{ source: 'class', classId: 'wizard', level: 5, x: 0, y: 0 }],
    enemies: [{ monsterId: 'dnd_5e_2014:monster:goblin', x: 8, y: 5 }] })
  sourceState.sessionCode = 'LAB-SOURCE'
  sourceState.enemies = []
  const sourceCreated = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: adminCookie,
    body: { code: 'LAB-SOURCE', name: 'Источник для стенда', state: sourceState } })
  assert.equal(sourceCreated.status, 201, sourceCreated.text)
  const populatedCatalog = await request(baseUrl, '/api/admin/combat-lab/catalog', { cookie: adminCookie })
  assert.equal(populatedCatalog.status, 200, populatedCatalog.text)
  assert.ok(populatedCatalog.body.heroes.some((hero) => hero.campaignId === 'LAB-SOURCE' && hero.id === sourceState.players[0].id))

  const badScenario = await request(baseUrl, '/api/admin/combat-lab/runs', {
    method: 'POST', cookie: adminCookie, body: { scenario: 'missing', seed: 1 },
  })
  assert.equal(badScenario.status, 400, badScenario.text)
  assert.equal(badScenario.body.code, 'INVALID_COMBAT_LAB_SCENARIO')
  const badSeed = await request(baseUrl, '/api/admin/combat-lab/runs', {
    method: 'POST', cookie: adminCookie, body: { scenario: 'duel', seed: 1.5 },
  })
  assert.equal(badSeed.status, 400, badSeed.text)
  assert.equal(badSeed.body.code, 'INVALID_COMBAT_LAB_SEED')

  const longRun = await request(baseUrl, '/api/admin/combat-lab/runs', {
    method: 'POST', cookie: adminCookie, body: { scenario: 'two-heroes', seed: 1 },
  })
  assert.equal(longRun.status, 202, longRun.text)
  assert.match(longRun.body.id, /^combat-lab-/u)
  const active = await request(baseUrl, '/api/admin/combat-lab/runs', { cookie: adminCookie })
  assert.equal(active.status, 200, active.text)
  assert.deepEqual(active.body.activeRun, { id: longRun.body.id })

  const busy = await request(baseUrl, '/api/admin/combat-lab/runs', {
    method: 'POST', cookie: adminCookie, body: { scenario: 'duel', seed: 2 },
  })
  assert.equal(busy.status, 409, busy.text)
  assert.equal(busy.body.code, 'COMBAT_LAB_BUSY')

  const live = await waitForRun(baseUrl, adminCookie, longRun.body.id, (run) => run.status === 'running' && run.frames.length >= 2)
  assert.equal(live.frames[0].index, 0)
  assert.ok(Array.isArray(live.frames[0].cells) && live.frames[0].cells.length > 0)
  assert.ok(live.frames[0].actors.some((actor) => actor.side === 'party' && actor.name === 'Воин'))
  assert.ok(live.frames[1].events.every((event) => event.id && event.text && Object.hasOwn(event, 'actorId')))

  const cancelled = await request(baseUrl, `/api/admin/combat-lab/runs/${longRun.body.id}`, {
    method: 'DELETE', cookie: adminCookie,
  })
  assert.equal(cancelled.status, 202, cancelled.text)
  assert.equal(cancelled.body.status, 'cancelled')
  const afterCancel = await request(baseUrl, `/api/admin/combat-lab/runs/${longRun.body.id}`, { cookie: adminCookie })
  assert.equal(afterCancel.status, 200, afterCancel.text)
  assert.equal(afterCancel.body.status, 'cancelled')
  const lastIndex = afterCancel.body.frames.at(-1).index
  const noNewFrames = await request(baseUrl, `/api/admin/combat-lab/runs/${longRun.body.id}?after=${lastIndex}`, { cookie: adminCookie })
  assert.equal(noNewFrames.status, 200, noNewFrames.text)
  assert.deepEqual(noNewFrames.body.frames, [], 'повторное чтение не пересылает старые кадры')
  const tailFrames = await request(baseUrl, `/api/admin/combat-lab/runs/${longRun.body.id}?after=0`, { cookie: adminCookie })
  assert.equal(tailFrames.status, 200, tailFrames.text)
  assert.ok(tailFrames.body.frames.every((frame) => frame.index > 0))

  const shortRun = await request(baseUrl, '/api/admin/combat-lab/runs', {
    method: 'POST', cookie: adminCookie, body: { scenario: 'duel', seed: 2 },
  })
  assert.equal(shortRun.status, 202, shortRun.text)
  const passed = await waitForRun(baseUrl, adminCookie, shortRun.body.id, (run) => run.status === 'passed' || run.status === 'failed')
  assert.equal(passed.status, 'passed', JSON.stringify(passed))
  assert.ok(passed.frames.some((frame) => frame.events.some((event) => event.text.includes('Бой'))))

  const configuredRun = await request(baseUrl, '/api/admin/combat-lab/runs', {
    method: 'POST', cookie: adminCookie,
    body: {
      seed: 3,
      config: {
        mapId: 'open-courtyard',
        party: [{ source: 'class', classId: 'fighter', level: 1, x: 0, y: 0 }],
        enemies: [{ monsterId: 'dnd_5e_2014:monster:goblin', x: 8, y: 5 }],
      },
    },
  })
  assert.equal(configuredRun.status, 202, configuredRun.text)
  const configured = await waitForRun(baseUrl, adminCookie, configuredRun.body.id, (run) => run.status === 'passed' || run.status === 'failed')
  assert.equal(configured.status, 'passed', JSON.stringify(configured))
  assert.equal(configured.frames[0].actors.length, 2)
  assert.equal(configured.frames[0].cells.length, catalog.body.maps.find((map) => map.id === 'open-courtyard').cells.length)
  const download = await request(baseUrl, `/api/admin/combat-lab/runs/${configured.id}/report`, { cookie: adminCookie })
  assert.equal(download.status, 200, download.text)
  assert.equal(download.body.trace.initial_state.ruleset_id, 'dnd_5e_2014')
  assert.ok(download.body.trace.steps.length > 0 && download.body.trace.rolls.length > 0)
  const forbiddenReport = await request(baseUrl, `/api/admin/combat-lab/runs/${configured.id}/report`, { cookie: playerCookie })
  assert.equal(forbiddenReport.status, 403, forbiddenReport.text)
})

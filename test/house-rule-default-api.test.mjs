// Правило «удар как в BG3» по умолчанию в идущих кампаниях.
//
// При старте сервер дописывает кампаниям событие включения правила
// (`enableDefaultHouseRules`, server/index.mjs). Здесь — то, что видно только
// через настоящий рестарт: выбор ведущего «выключено» переживает перезапуск, а
// повторный старт ничего не дописывает в журнал. Решение «кого включать» само
// по себе сторожит `test/campaign-ruleset.test.mjs`.
import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

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
    const timer = setTimeout(() => reject(new Error('Test server did not stop')), 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, log) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited with ${child.exitCode}\n${log()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return response.json()
    } catch { /* сервер ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Test server did not become healthy\n${log()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const headers = { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { Cookie: cookie } : {}) }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* сообщение ниже покажет сырое тело */ }
  return { response, status: response.status, body: json, text }
}

const sessionCookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

function assertStatus(result, expected, log) {
  assert.equal(result.status, expected, `${result.text.slice(0, 2000)}\n${log().slice(-2000)}`)
}

const bg3 = (body) => body?.ruleset?.houseRules?.find((rule) => rule.id === 'house:bg3-opening-strike')

const campaignState = (code) => ({
  sessionCode: code, campaign: code, partyName: 'Отряд', partyMemberIds: ['hero'], activePlayerId: 'hero',
  isNarrating: false, pendingCheck: null, suggestions: [], messages: [],
  players: [{
    id: 'hero', name: 'Игрок', character: 'Астер', hp: 20, maxHp: 20, armor: 14, speed: 30, proficiency: 2,
    abilities: { str: 14, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], online: true, x: 0, y: 0,
  }],
  enemies: [],
  scene: {
    title: 'Привал', location: 'Привал', mood: 'Тихо', objective: 'Проверка', turn: 1,
    cells: [0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => ({ x, y, type: 'floor', revealed: true }))),
  },
  adventure: { chapter: 1, history: [], visitedLocations: ['Привал'] },
  engine_mode: 'enforce',
})

test('выключенное ведущим правило BG3 переживает рестарт, а старт ничего не дублирует', { timeout: runnerTimeout(40_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-house-rule-default-'))
  const setupToken = 'house-rule-default-token'
  const credentials = { email: 'admin@house-rule.test', password: 'very-secure-admin-password' }
  let logs = ''
  const log = () => logs
  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  let child = startServer({ port, storage, setupToken, appendLog: (chunk) => { logs += chunk } })
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })
  await waitForHealth(baseUrl, child, log)
  const setup = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: { name: 'Admin', ...credentials, setupToken } })
  assertStatus(setup, 201, log)
  let cookie = sessionCookie(setup)
  for (const code of ['HR-ON', 'HR-OFF']) {
    assertStatus(await request(baseUrl, '/api/campaigns', { method: 'POST', cookie, body: { code, name: code, state: campaignState(code) } }), 201, log)
  }
  assertStatus(await request(baseUrl, '/api/campaigns/HR-OFF/settings', {
    method: 'PATCH', cookie, body: { idempotency_key: 'hr-off', houseRules: { 'house:bg3-opening-strike': false } },
  }), 200, log)
  const versions = {}
  for (const code of ['HR-ON', 'HR-OFF']) {
    versions[code] = (await request(baseUrl, `/api/rooms/${code}`, { cookie })).body.state.state_version
  }

  await stopServer(child)
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, setupToken, appendLog: (chunk) => { logs += chunk } })
  await waitForHealth(baseUrl, child, log)
  cookie = sessionCookie(await request(baseUrl, '/api/auth/login', { method: 'POST', body: credentials }))
  // Проверка правил идёт фоном через 250 мс после старта — даём ей пройти.
  await new Promise((resolve) => setTimeout(resolve, 1_500))

  assert.equal(bg3((await request(baseUrl, '/api/campaigns/HR-ON/settings', { cookie })).body)?.enabled, true, 'новая кампания играет с ударом как в BG3')
  assert.equal(bg3((await request(baseUrl, '/api/campaigns/HR-OFF/settings', { cookie })).body)?.enabled, false, 'выбор ведущего важнее умолчания')
  for (const code of ['HR-ON', 'HR-OFF']) {
    const room = await request(baseUrl, `/api/rooms/${code}`, { cookie })
    assert.equal(room.body.state.state_version, versions[code], `${code}: рестарт ничего не дописал в журнал`)
  }
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Кости и выпивка доступны настоящему игроку через основной сайт.
 *
 * Проба сквозная и ходит теми же путями, что и браузер: карточки действий —
 * POST в `/api/campaigns/:code/commands`, ручной ответный бросок — вторым
 * запросом с `roll_id` из `/api/roll`. Ключа модели у сервера нет, поэтому всё
 * здесь обязано быть детерминированным.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const SESSION = 'TAVERN-API'
const INN = 'Трактир «У моста»'

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
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: setupToken, GAME_ENGINE_MODE: 'enforce',
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

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* assertion reports raw body */ }
  return { response, status: response.status, body: json, text }
}

function cookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

function cells(width = 6, height = 6) {
  const grid = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) grid.push({ x, y, type: 'floor', passable: true, revealed: true })
  }
  return grid
}

function seededState() {
  return {
    sessionCode: SESSION,
    campaign: 'Жизнь таверны',
    partyName: 'Отряд героев',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    engine_mode: 'enforce',
    isNarrating: false,
    pendingCheck: null,
    messages: [],
    scene: {
      title: INN, location: INN, location_id: 'inn', mood: '', objective: '', turn: 1,
      grid: { width: 6, height: 6 }, cells: cells(),
    },
    players: [{
      id: 'hero', name: 'Player', character: 'Ада', hp: 20, maxHp: 20, armor: 12, speed: 30, x: 1, y: 1, level: 3,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 12 },
      proficiency: 2, classSkillProficiencies: [], savingThrowProficiencies: [],
      currency: { copper: 0, silver: 0, gold: 2, platinum: 0 }, inventory: [], online: true,
    }],
    worldMap: { seed: 'tavern-api', locations: [{ id: 'inn', name: INN, kind: 'village', x: 100, y: 300 }], routes: [] },
    enemies: [],
    social: {
      npcs: [{ id: 'barkeep', name: 'Трактирщик Бажен', role: 'трактирщик', location: INN, visibility: 'party', public_summary: 'Хозяин зала.' }],
    },
    mechanics: { world_time: { amount: 0, unit: 'minute', elapsed_minutes: 0 } },
  }
}

async function setUp(t) {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-tavern-api-'))
  const setupToken = 'tavern-api-setup-token'
  let logs = ''
  let child = null
  const log = () => logs
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, setupToken, appendLog: (chunk) => { logs += chunk } })
  await waitForHealth(baseUrl, child, log)
  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Tavern Admin', email: 'admin@tavern.test', password: 'very-secure-admin-password', setupToken },
  })
  assert.equal(setup.status, 201, `${setup.text}\n${log()}`)
  const adminCookie = cookie(setup)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: SESSION, name: 'Таверна', state: seededState() },
  })
  assert.equal(created.status, 201, `${created.text}\n${log()}`)
  return { baseUrl, adminCookie, log }
}

test('раунд костей проходит настоящим путём: чужая кость, ручной бросок, банк', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const idle = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.ok(idle.body.state.tavern, `карточка заведения обязана доехать игроку\n${idle.text}`)
  const stake = idle.body.state.tavern.stakes[0].stake_cp

  const opened = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-open',
      command: { command_type: 'OpenTavernDiceRound', actor_id: 'hero', npc_id: 'barkeep', stake_cp: stake },
    },
  })
  assert.equal(opened.status, 200, `${opened.text}\n${log()}`)
  const afterOpen = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  const round = afterOpen.body.state.tavern.round
  assert.ok(round, `кость соперника обязана лечь на стол\n${afterOpen.text}`)
  assert.equal(round.target, round.npc_total + 1)
  assert.equal(afterOpen.body.state.lastDiceRoll.value, round.npc_total, 'кость соперника видна в общем лотке')

  // Первая фаза ответа: сервер объявляет проверку против уже лежащего числа.
  const announced = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-answer-1',
      manual_roll: true,
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'fair' },
    },
  })
  assert.equal(announced.status, 200, `${announced.text}\n${log()}`)
  assert.ok(announced.body.check?.check_id, `сервер обязан вернуть карточку броска\n${announced.text}`)
  assert.equal(announced.body.check.difficulty, round.target, 'СЛ карточки — это кость соперника, а не выдуманное число')
  assert.equal(announced.body.check.modifier, 0, 'за столом кидают удачу, а не характеристику')

  const rolled = await request(baseUrl, '/api/roll', {
    method: 'POST',
    cookie: adminCookie,
    body: { campaignId: SESSION, playerId: 'hero', checkId: announced.body.check.check_id },
  })
  assert.equal(rolled.status, 200, `${rolled.text}\n${log()}`)

  const resolved = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-answer-2',
      roll: { roll_id: rolled.body.roll_id },
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'fair' },
    },
  })
  assert.equal(resolved.status, 200, `${resolved.text}\n${log()}`)
  const settled = (resolved.body.mechanics ?? []).find((event) => event.event_type === 'TavernDiceRoundResolved')
  assert.ok(settled, `раунд обязан закрыться событием\n${resolved.text}`)
  assert.equal(settled.payload.hero_total, rolled.body.total, 'движок считает по броску игрока, а не бросает заново')

  const after = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.equal(after.body.state.tavern.round, null, 'раунд закрыт')
  const purse = after.body.state.players[0].currency
  const purseCp = purse.copper + purse.silver * 10 + purse.gold * 100 + purse.platinum * 1_000
  const expected = settled.payload.outcome === 'win' ? 200 + stake
    : settled.payload.outcome === 'loss' ? 200 - stake : 200
  assert.equal(purseCp, expected, `банк обязан сойтись с исходом ${settled.payload.outcome}`)
  assert.ok(purseCp >= 0, 'кошелёк не уходит в минус ни при каком исходе')
})

test('во вторую фазу раунда принимается только бросок, зарегистрированный костями', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const opened = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-open-foreign',
      command: { command_type: 'OpenTavernDiceRound', actor_id: 'hero', npc_id: 'barkeep', stake_cp: 10 },
    },
  })
  assert.equal(opened.status, 200, `${opened.text}\n${log()}`)

  const foreign = await request(baseUrl, '/api/roll', {
    method: 'POST',
    cookie: adminCookie,
    body: { campaignId: SESSION, playerId: 'hero', label: 'Проверка Ловкости', modifier: 12, difficulty: 5 },
  })
  assert.equal(foreign.status, 200, `${foreign.text}\n${log()}`)

  const rejected = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-foreign-roll',
      roll: { roll_id: foreign.body.roll_id },
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'fair' },
    },
  })
  assert.equal(rejected.status, 400, rejected.text)
  assert.equal(rejected.body.code, 'ROLL_CONTEXT_MISMATCH')

  // Ставку и характер соперника клиент подсказать не может: лишнее поле в
  // команде — отказ, а не молчаливое игнорирование.
  const forgedField = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-forged-field',
      command: { command_type: 'OrderTavernDrink', actor_id: 'hero', difficulty: 1 },
    },
  })
  assert.equal(forgedField.status, 400, forgedField.text)
  assert.equal(forgedField.body.code, 'TAVERN_COMMAND_UNKNOWN_FIELD')

  const after = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.ok(after.body.state.tavern.round, 'чужой бросок раунда не закрывает')
})

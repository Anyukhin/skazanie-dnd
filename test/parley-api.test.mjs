import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Парлей доступен настоящему игроку через основной сайт.
 *
 * Проба сквозная и ходит теми же путями, что и браузер: кнопка хотбара — один
 * POST в `/api/campaigns/:code/commands`, ручной бросок — вторым запросом с
 * `roll_id` из `/api/roll`, свободная фраза — обычным `/api/narrate`. Ключа
 * модели у сервера нет, поэтому всё, что здесь происходит, обязано быть
 * детерминированным.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const SESSION = 'PARLEY-API'
const ROAD = 'Разбитый тракт'

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

function cells(width = 8, height = 8) {
  const grid = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) grid.push({ x, y, type: 'floor', passable: true, revealed: true })
  }
  return grid
}

/** Бой в разгаре: двое разбойников выбыли, третий держится на последних хитах. */
function seededState() {
  return {
    sessionCode: SESSION,
    campaign: 'Парлей',
    partyName: 'Отряд героев',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    engine_mode: 'enforce',
    isNarrating: false,
    pendingCheck: null,
    messages: [],
    scene: {
      title: 'Тракт', location: ROAD, location_id: 'road', mood: '', objective: '', turn: 2,
      grid: { width: 8, height: 8 }, cells: cells(),
    },
    players: [{
      id: 'hero', name: 'Player', character: 'Ада', hp: 14, maxHp: 14, armor: 12, speed: 30, x: 1, y: 1,
      abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 12, cha: 16 },
      proficiency: 2, backgroundSkillProficiencies: ['persuasion'], inventory: [], online: true,
    }],
    worldMap: { seed: 'parley-api', locations: [{ id: 'road', name: ROAD, kind: 'wilds', x: 100, y: 300 }], routes: [] },
    enemies: [
      {
        id: 'enemy-leader', name: 'Разбойник 1', hp: 3, maxHp: 11, armor: 12, speed: 30, x: 2, y: 1, alive: true,
        creature_type: 'humanoid', stat_block_id: 'srd_5_2_1:bandit', provenance: { xp: 25 },
        attackBonus: 3, damageDice: 6, damageBonus: 1,
      },
      {
        id: 'enemy-fallen-1', name: 'Разбойник 2', hp: 0, maxHp: 11, armor: 12, speed: 30, x: 5, y: 2, alive: false,
        creature_type: 'humanoid', stat_block_id: 'srd_5_2_1:bandit', provenance: { xp: 25 },
      },
      {
        id: 'enemy-fallen-2', name: 'Разбойник 3', hp: 0, maxHp: 11, armor: 12, speed: 30, x: 5, y: 3, alive: false,
        creature_type: 'humanoid', stat_block_id: 'srd_5_2_1:bandit', provenance: { xp: 25 },
      },
    ],
    social: { npcs: [] },
    mechanics: {
      world_time: { amount: 0, unit: 'minute', elapsed_minutes: 0 },
      combat: {
        active: true,
        round: 2,
        initiative: [{ actor_id: 'hero', total: 18 }, { actor_id: 'enemy-leader', total: 9 }],
        active_index: 0,
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement_spent: 0 } },
      },
    },
  }
}

async function setUp(t) {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-parley-api-'))
  const setupToken = 'parley-api-setup-token'
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
    body: { name: 'Parley Admin', email: 'admin@parley.test', password: 'very-secure-admin-password', setupToken },
  })
  assert.equal(setup.status, 201, `${setup.text}\n${log()}`)
  const adminCookie = cookie(setup)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: SESSION, name: 'Парлей', state: seededState() },
  })
  assert.equal(created.status, 201, `${created.text}\n${log()}`)
  return { baseUrl, adminCookie, log }
}

test('парлей из хотбара идёт двухфазным ручным броском и замораживает очередь', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  // Первая фаза: сервер объявляет проверку и ничего не коммитит.
  const announced = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'parley-phase-1',
      manual_roll: true,
      command: { command_type: 'ProposeParley', actor_id: 'hero', skill: 'persuasion' },
    },
  })
  assert.equal(announced.status, 200, `${announced.text}\n${log()}`)
  assert.ok(announced.body.check?.check_id, `сервер обязан вернуть карточку проверки\n${announced.text}`)
  assert.equal(announced.body.check.sides, 20)
  assert.ok(Number.isSafeInteger(announced.body.check.difficulty))

  const beforeRoll = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.equal(beforeRoll.body.state.mechanics.combat.truce ?? null, null, 'до броска перемирия быть не может')

  // Кубик бросает игрок — но через серверный реестр.
  const rolled = await request(baseUrl, '/api/roll', {
    method: 'POST',
    cookie: adminCookie,
    body: { campaignId: SESSION, playerId: 'hero', checkId: announced.body.check.check_id },
  })
  assert.equal(rolled.status, 200, `${rolled.text}\n${log()}`)
  assert.ok(rolled.body.roll_id)

  // Выдуманный клиентом бросок сервер не принимает.
  const forged = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'parley-forged',
      roll: { total: 30 },
      command: { command_type: 'ProposeParley', actor_id: 'hero', skill: 'persuasion' },
    },
  })
  assert.equal(forged.status, 400, forged.text)
  assert.equal(forged.body.code, 'UNVERIFIED_ROLL')

  // Вторая фаза: та же команда с серверным roll_id.
  const resolved = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'parley-phase-2',
      roll: { roll_id: rolled.body.roll_id },
      command: { command_type: 'ProposeParley', actor_id: 'hero', skill: 'persuasion' },
    },
  })
  assert.equal(resolved.status, 200, `${resolved.text}\n${log()}`)
  const proposed = (resolved.body.mechanics ?? []).find((event) => event.event_type === 'ParleyProposed')
  assert.ok(proposed, `парлей не создал события\n${resolved.text}`)
  assert.equal(proposed.payload.total, rolled.body.total, 'движок считает по броску игрока, а не бросает заново')

  const room = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  const combat = room.body.state.mechanics.combat
  assert.equal(combat.active, true)
  assert.equal(combat.parley_attempts, 1)
  if (proposed.payload.success === true) {
    assert.ok(combat.truce, 'успешный парлей обязан оставить перемирие на доске')
    assert.equal(combat.truce.leader_id, 'enemy-leader')
    // Очередь заморожена: планировщик ходов NPC на перемирии не работает, и
    // раунд не уехал вперёд сам собой.
    assert.equal(combat.round, 2)
    assert.ok((combat.truce.outcomes ?? []).includes('withdraw'))
  } else {
    assert.equal(combat.truce ?? null, null)
    assert.ok((room.body.state.battleLog ?? []).some((entry) => entry.type === 'parley-rejected'))
  }
})

test('свободная фраза о переговорах доходит до правила, а не до уточнения', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const shouted = await request(baseUrl, '/api/narrate', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      campaign_id: SESSION,
      actor_id: 'hero',
      idempotency_key: 'parley-shout-1',
      action: 'Кричу им: остановитесь, поговорим!',
    },
  })
  assert.equal(shouted.status, 200, `${shouted.text}\n${log()}`)
  const events = shouted.body.mechanics ?? []
  assert.ok(
    events.some((event) => event.event_type === 'ParleyProposed'),
    `фраза о переговорах обязана дойти до правила\n${shouted.text}`,
  )
  // Уточнения быть не должно: собеседника в бою называть некому, и раньше
  // ровно на этом фраза и застревала.
  assert.doesNotMatch(String(shouted.body.narration ?? ''), /[Уу]точните/u)
})

test('свободная фраза тоже уважает ручной бросок: карточка, кубик, тот же ход', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const announced = await request(baseUrl, '/api/narrate', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      campaign_id: SESSION,
      actor_id: 'hero',
      idempotency_key: 'parley-manual-1',
      manual_roll: true,
      action: 'Предлагаю переговоры: хватит драться!',
    },
  })
  assert.equal(announced.status, 200, `${announced.text}\n${log()}`)
  assert.ok(announced.body.check?.check_id, `фраза обязана вернуть карточку проверки\n${announced.text}`)
  assert.equal((announced.body.mechanics ?? []).length, 0, 'до броска мир меняться не должен')

  const rolled = await request(baseUrl, '/api/roll', {
    method: 'POST',
    cookie: adminCookie,
    body: { campaignId: SESSION, playerId: 'hero', checkId: announced.body.check.check_id },
  })
  assert.equal(rolled.status, 200, `${rolled.text}\n${log()}`)

  const resolved = await request(baseUrl, '/api/narrate', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      campaign_id: SESSION,
      actor_id: 'hero',
      idempotency_key: 'parley-manual-2',
      action: 'Предлагаю переговоры: хватит драться!',
      roll: { roll_id: rolled.body.roll_id },
    },
  })
  assert.equal(resolved.status, 200, `${resolved.text}\n${log()}`)
  const proposed = (resolved.body.mechanics ?? []).find((event) => event.event_type === 'ParleyProposed')
  assert.ok(proposed, `вторая фаза не довела парлей до правила\n${resolved.text}`)
  assert.equal(proposed.payload.total, rolled.body.total, 'движок считает по броску игрока')
})

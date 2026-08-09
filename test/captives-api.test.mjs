import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Пленный доступен настоящему игроку через основной сайт, а не только движку.
 *
 * Проба сквозная и нарочно ходит теми же путями, что и браузер: один POST в
 * `/api/campaigns/:code/commands` на действие, чтение комнаты — обычным GET.
 * Отдельно проверяется, что голод пленного двигают серверные часы: `system-tick`
 * здесь не зовётся ни разу, ровно как в игре.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const SESSION = 'CAPTIVE-API'
const VILLAGE = 'Тихий Брод'
const CAPTIVE_ID = 'captive:seeded'
const LEAD_FACT_ID = 'fact:captive-lead:seeded'

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

/** Кампания с уже взятым пленным: бой сыгран, отряд стоит в деревне. */
function seededState({ minutes = 0 } = {}) {
  return {
    sessionCode: SESSION,
    campaign: 'Пленные',
    partyName: 'Отряд героев',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    engine_mode: 'enforce',
    isNarrating: false,
    pendingCheck: null,
    messages: [],
    scene: { title: 'Околица', location: VILLAGE, location_id: 'village', mood: '', objective: '', turn: 0, cells: [] },
    players: [{
      id: 'hero', name: 'Player', character: 'Ада', hp: 10, maxHp: 10, armor: 12,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 16 },
      proficiency: 2, backgroundSkillProficiencies: ['intimidation'], inventory: [], online: true,
    }],
    worldMap: { seed: 'captive-api', locations: [{ id: 'village', name: VILLAGE, kind: 'village', x: 100, y: 300 }], routes: [] },
    social: {
      npcs: [
        { id: 'watchman', name: 'Страж Бран', role: 'страж', location: VILLAGE, visibility: 'party', public_summary: 'Держит порядок.', tags: ['faction:brod-watch'] },
        { id: 'enemy-1', name: 'Кривой Ждан', role: 'Бандит', location: VILLAGE, visibility: 'party', public_summary: 'Пленник отряда.', tags: ['captive', 'faction:band:bandit'] },
      ],
    },
    worldMemory: {
      entities: [{ id: 'enemy-1', kind: 'npc', name: 'Кривой Ждан', summary: 'Пленник.', visibility: 'party', tags: ['captive'] }],
      facts: [{
        id: LEAD_FACT_ID, subject_id: 'enemy-1', predicate: 'band_camp', object: 'bandit',
        summary: 'Лагерь ватаги стоит к северу от «Тихий Брод».', visibility: 'gm_only', status: 'active',
        source_event_ids: [], recorded_at_minutes: 0,
      }],
    },
    mechanics: { world_time: { amount: minutes, unit: 'minute', elapsed_minutes: minutes } },
    captives: {
      schema_version: 1,
      captives: [{
        id: CAPTIVE_ID, npc_id: 'enemy-1', actor_id: 'enemy-1', name: 'Кривой Ждан', role: 'Бандит',
        temper: 'broken', origin: 'surrendered', status: 'held', band_id: 'bandit',
        stat_block_id: 'srd_5_2_1:bandit', xp: 25, taken_at_minutes: 0,
        location_id: 'village', location_name: VILLAGE,
        known_fact_ids: [LEAD_FACT_ID], revealed_fact_ids: [], interrogations: 0,
        last_fed_at_minutes: 0,
      }],
    },
  }
}

async function setUp(t, state) {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-captive-api-'))
  const setupToken = 'captive-api-setup-token'
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
    body: { name: 'Captive Admin', email: 'admin@captive.test', password: 'very-secure-admin-password', setupToken },
  })
  assert.equal(setup.status, 201, `${setup.text}\n${log()}`)
  const adminCookie = cookie(setup)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: SESSION, name: 'Пленные', state },
  })
  assert.equal(created.status, 201, `${created.text}\n${log()}`)
  return { baseUrl, adminCookie, log }
}

test('игрок допрашивает и сдаёт пленного через обычный маршрут команд', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t, seededState())

  const interrogation = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'captive-interrogate-1',
      command: { command_type: 'InterrogateCaptive', actor_id: 'hero', captive_id: CAPTIVE_ID, skill: 'intimidation' },
    },
  })
  assert.equal(interrogation.status, 200, `${interrogation.text}\n${log()}`)
  const interrogated = (interrogation.body.mechanics ?? []).find((event) => event.event_type === 'CaptiveInterrogated')
  assert.ok(interrogated, `допрос не создал события\n${interrogation.text}`)
  assert.equal(interrogated.payload.captive_id, CAPTIVE_ID)
  // СЛ и модификатор считает сервер: клиент их не присылал.
  assert.ok(Number.isSafeInteger(interrogated.payload.difficulty))
  assert.match(String(interrogation.body.narration ?? ''), /пленного/u)

  // Повтор того же ключа не допрашивает второй раз.
  const replay = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'captive-interrogate-1',
      command: { command_type: 'InterrogateCaptive', actor_id: 'hero', captive_id: CAPTIVE_ID, skill: 'intimidation' },
    },
  })
  assert.equal(replay.status, 200, `${replay.text}\n${log()}`)
  const afterReplay = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.equal(afterReplay.body.state.captives.captives[0].interrogations, 1)

  const handover = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'captive-handover-1',
      command: { command_type: 'HandCaptiveToGuards', actor_id: 'hero', captive_id: CAPTIVE_ID },
    },
  })
  assert.equal(handover.status, 200, `${handover.text}\n${log()}`)
  const room = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  const captive = room.body.state.captives.captives[0]
  assert.equal(captive.status, 'handed_over')
  assert.ok((room.body.state.worldMemory?.facts ?? []).some((fact) => fact.predicate === 'handed_to_watch'))
  assert.equal(room.body.state.autonomy.reputations['brod-watch'], 3)

  // Решённого пленного вторично не сдают.
  const again = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'captive-handover-2',
      command: { command_type: 'HandCaptiveToGuards', actor_id: 'hero', captive_id: CAPTIVE_ID },
    },
  })
  assert.equal(again.status, 400, again.text)
  assert.equal(again.body.code, 'CAPTIVE_ALREADY_RESOLVED')
})

test('голод пленного отмечают серверные часы, а не запрос клиента', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t, seededState({ minutes: 2_000 }))

  let room = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const read = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
    assert.equal(read.status, 200, `${read.text}\n${log()}`)
    room = read.body
    if (room.state.captives?.captives?.[0]?.neglected_at_minutes != null) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(
    room.state.captives.captives[0].neglected_at_minutes,
    2_000,
    `часы голода не сработали\n${JSON.stringify(room.state.captives ?? {}, null, 1)}\n${log()}`,
  )
  // Голод стал поступком жестокости в летописи ведущего.
  const deeds = room.state.world_deeds?.deeds ?? []
  assert.equal(deeds.length, 1, JSON.stringify(deeds, null, 1))
  assert.equal(deeds[0].kind, 'cruelty')
  assert.deepEqual(deeds[0].witness_ids, ['watchman'])
})

test('часы голода живут в серверном драйвере, а не в HTTP-роуте', () => {
  const source = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')
  const driver = source.match(/function nudgeWorldClocks\(campaignId\) \{[\s\S]*?\n\}/u)?.[0] ?? ''
  assert.match(driver, /runCaptiveClock\(/u, 'у часов голода снова нет серверного драйвера')
})

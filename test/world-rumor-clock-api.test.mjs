import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Часы молвы обязаны идти сами.
 *
 * Роут `system-tick` их приводом быть не может: клиент его не дёргает, и это
 * закреплено сторожами (`realtime-combat-transport`, `ui-hud-wave`). Пока у
 * часов молвы не было серверного драйвера, `RecordRumor` не писался в реальной
 * игре никогда — работал только редьюсер летописи, а лента «что уже говорят» и
 * репутация оставались пустыми.
 *
 * Проба сквозная и намеренно ни разу не зовёт `system-tick`: кампания просто
 * создаётся, а слух и реакция мира обязаны появиться сами.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const SESSION = 'RUMOR-CLOCK'
const VILLAGE = 'Тихий Брод'

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

/** Кампания с готовым поступком: срок местной молвы уже прошёл. */
function seededState() {
  return {
    sessionCode: SESSION,
    campaign: 'Часы молвы',
    partyName: 'Отряд героев',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    engine_mode: 'enforce',
    isNarrating: false,
    pendingCheck: null,
    messages: [],
    scene: { title: 'Площадь', location: VILLAGE, location_id: 'village', mood: '', objective: '', turn: 0, cells: [] },
    players: [{ id: 'hero', name: 'Player', character: 'Ада', hp: 10, maxHp: 10, armor: 12, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, inventory: [], online: true }],
    worldMap: {
      seed: 'rumor-clock',
      locations: [{ id: 'village', name: VILLAGE, kind: 'village', x: 100, y: 300 }],
      routes: [],
    },
    social: {
      npcs: [{
        id: 'baker', name: 'Пекарь Мила', role: 'пекарь', location: VILLAGE, visibility: 'party',
        public_summary: 'Печёт хлеб на площади.', tags: ['faction:brod-guild'],
      }],
    },
    mechanics: { world_time: { amount: 1_000, unit: 'minute', elapsed_minutes: 1_000 } },
    world_deeds: {
      schema_version: 1,
      deeds: [{
        id: 'deed:seeded-murder',
        kind: 'murder',
        alignment: 'dark',
        severity: 'grave',
        actor_ids: ['hero'],
        actor_names: ['Ада'],
        subject: 'Страж Бран',
        location_id: 'village',
        location_name: VILLAGE,
        at_minutes: 0,
        witness_ids: ['baker'],
        summary: 'Ада: убийство — Страж Бран (Тихий Брод)',
        source_event_ids: [],
        spread_at_minutes: 0,
        reputation_faction_ids: [],
      }],
    },
  }
}

test('часы молвы идут сами: слух и реакция мира приходят без system-tick', { timeout: runnerTimeout(40_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-rumor-clock-'))
  const setupToken = 'rumor-clock-setup-token'
  let logs = ''
  let child = null
  const log = () => logs
  const appendLog = (chunk) => { logs += chunk }
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, setupToken, appendLog })
  await waitForHealth(baseUrl, child, log)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Rumor Admin', email: 'admin@rumor.test', password: 'very-secure-admin-password', setupToken },
  })
  assert.equal(setup.status, 201, `${setup.text}\n${log()}`)
  const adminCookie = cookie(setup)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: SESSION, name: 'Часы молвы', state: seededState() },
  })
  assert.equal(created.status, 201, `${created.text}\n${log()}`)
  assert.equal(created.body.state.world_deeds.deeds.length, 1)
  // На момент создания мир ещё молчит: слух рождают именно часы.
  assert.deepEqual(created.body.state.worldMemory?.epistemic_claims ?? [], [])

  let room = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const read = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
    assert.equal(read.status, 200, `${read.text}\n${log()}`)
    room = read.body
    const rumors = (room.state.worldMemory?.epistemic_claims ?? []).filter((claim) => claim.kind === 'rumor')
    if (rumors.length && Number(room.state.autonomy?.reputations?.['brod-guild'] ?? 0) !== 0) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const rumors = (room.state.worldMemory?.epistemic_claims ?? []).filter((claim) => claim.kind === 'rumor')
  assert.equal(rumors.length, 1, `слух так и не родился\n${JSON.stringify(room.state.worldMemory ?? {}, null, 1)}\n${log()}`)
  assert.equal(rumors[0].holder_entity_id, 'baker')
  assert.equal(rumors[0].visibility, 'gm_only')
  assert.match(rumors[0].claim, /Тихий Брод/u)
  // Реакция мира: прямой свидетель тяжкого поступка стоит полной поправки.
  assert.equal(room.state.autonomy.reputations['brod-guild'], -8)
  // Факт поступка тоже ушёл ведущему.
  assert.ok((room.state.worldMemory?.facts ?? []).some((fact) => fact.predicate === 'party_deed'))
  // Такт идемпотентен: повторные сохранения комнаты второй раз не платят.
  const repeat = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.equal((repeat.body.state.worldMemory?.epistemic_claims ?? []).filter((claim) => claim.kind === 'rumor').length, 1)
  assert.equal(repeat.body.state.autonomy.reputations['brod-guild'], -8)
})

test('привод часов молвы живёт в серверном драйвере, а не в HTTP-роуте', () => {
  const source = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')
  const driver = source.match(/function nudgeWorldClocks\(campaignId\) \{[\s\S]*?\n\}/u)?.[0] ?? ''
  assert.match(driver, /runWorldRumorClock\(/u, 'у часов молвы снова нет серверного драйвера')
  assert.match(source, /onRoomSaved\(\(campaignId, room\) => \{[\s\S]*?nudgeWorldClocks\(campaignId\)/u)
})

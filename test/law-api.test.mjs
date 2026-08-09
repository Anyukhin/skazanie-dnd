import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Встреча со стражей доступна настоящему игроку через основной сайт.
 *
 * Проба сквозная и ходит теми же путями, что и браузер: кнопка карточки — один
 * POST в `/api/campaigns/:code/commands`, ручной бросок побега — вторым
 * запросом с `roll_id` из `/api/roll`. Ключа модели у сервера нет, поэтому всё,
 * что здесь происходит, обязано быть детерминированным.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const SESSION = 'LAW-API'
const VILLAGE = 'Тихий Брод'
const REGION = 'north'

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

function cells(width = 16, height = 16) {
  const grid = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) grid.push({ x, y, type: 'floor', passable: true, revealed: true })
  }
  return grid
}

/**
 * Отряд стоит в деревне, за ним числится убийство при свидетелях, и стража уже
 * вышла навстречу. Состояние посеяно готовым: сама встреча на входе в сцену
 * проверена отдельно (`test/law-and-order.test.mjs`), а здесь важно, что
 * настоящий игрок может ответить страже через сайт.
 *
 * Ловкость 18 с владением Скрытностью и бонусом мастерства 4 даёт модификатор
 * +8, а СЛ побега посеяна равной 9, поэтому минимальный итог 9 ≥ 9: проверка
 * проходит при любом кубике. Иначе каждый пятый прогон падал бы на кости, а не
 * на коде.
 */
function seededState() {
  return {
    sessionCode: SESSION,
    campaign: 'Закон',
    partyName: 'Отряд героев',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    engine_mode: 'enforce',
    isNarrating: false,
    pendingCheck: null,
    messages: [],
    scene: {
      title: 'Ворота', location: VILLAGE, location_id: 'village', mood: '', objective: '', turn: 2,
      grid: { width: 16, height: 16 }, cells: cells(),
    },
    players: [{
      id: 'hero', name: 'Player', character: 'Ада', hp: 48, maxHp: 48, armor: 12, speed: 30, x: 1, y: 1, level: 9,
      abilities: { str: 10, dex: 18, con: 12, int: 10, wis: 12, cha: 12 },
      proficiency: 4, backgroundSkillProficiencies: ['stealth'], inventory: [], online: true,
      currency: { copper: 0, silver: 0, gold: 200, platinum: 0 },
    }],
    worldMap: {
      seed: 'law-api',
      regions: [
        { id: REGION, name: 'Северный край', biome: 'plains', x: 200, y: 200, radius: 205 },
        { id: 'south', name: 'Южный край', biome: 'marsh', x: 200, y: 520, radius: 205 },
        { id: 'east', name: 'Восточный край', biome: 'coast', x: 820, y: 300, radius: 205 },
      ],
      locations: [
        { id: 'village', name: VILLAGE, kind: 'village', x: 200, y: 200, regionId: REGION },
        { id: 'road', name: 'Старый тракт', kind: 'landmark', x: 260, y: 240, regionId: REGION },
      ],
      routes: [{ id: 'r1', from: 'village', to: 'road', kind: 'road' }],
    },
    enemies: [],
    social: { npcs: [] },
    law: {
      schema_version: 1,
      crimes: [{
        id: 'crime:seeded-murder',
        kind: 'murder',
        points: 4,
        region_id: REGION,
        region_name: 'Северный край',
        node_id: 'village',
        place_name: VILLAGE,
        at_minutes: 0,
        witnesses: 2,
        summary: 'Ада: убийство — Возчик Сём (Тихий Брод)',
      }],
      cleared: {},
      encounter: {
        id: 'guard-encounter:seeded',
        region_id: REGION,
        region_name: 'Северный край',
        node_id: 'village',
        place_name: VILLAGE,
        level: 2,
        fine_cp: 2_000,
        officer_name: 'Радим',
        officer_rank: 'начальник караула',
        demand: '«Придержите коней. О вас тут спрашивали».',
        escape_dc: 9,
        escape_attempts: 0,
        started_at_minutes: 0,
      },
    },
    mechanics: {
      world_time: { amount: 0, unit: 'minute', elapsed_minutes: 0 },
      combat: { active: false, round: 0, initiative: [], active_index: 0 },
    },
  }
}

async function setUp(t) {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-law-api-'))
  const setupToken = 'law-api-setup-token'
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
    body: { name: 'Law Admin', email: 'admin@law.test', password: 'very-secure-admin-password', setupToken },
  })
  assert.equal(setup.status, 201, `${setup.text}\n${log()}`)
  const adminCookie = cookie(setup)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: SESSION, name: 'Закон', state: seededState() },
  })
  assert.equal(created.status, 201, `${created.text}\n${log()}`)
  return { baseUrl, adminCookie, log }
}

test('вира платится через сайт и снимает розыск в этом краю', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const before = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.equal(before.body.state.law.encounter.fine_cp, 2_000, `${before.text}\n${log()}`)

  const paid = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'law-fine',
      command: { command_type: 'ResolveGuardEncounter', actor_id: 'hero', resolution: 'fine' },
    },
  })
  assert.equal(paid.status, 200, `${paid.text}\n${log()}`)
  const resolved = (paid.body.mechanics ?? []).find((event) => event.event_type === 'GuardEncounterResolved')
  assert.ok(resolved, `вира не создала события\n${paid.text}`)
  assert.equal(resolved.payload.paid_cp, 2_000)
  assert.ok((paid.body.mechanics ?? []).some((event) => event.event_type === 'WantedCleared'))

  const room = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.equal(room.body.state.law.encounter ?? null, null, 'стража расходится')
  const north = room.body.state.law.regions.find((region) => region.region_id === REGION)
  assert.equal(north.level, 0, 'ступень снята')
  assert.equal(north.crimes[0].cleared_reason, 'fine')
  const purse = room.body.state.players.find((player) => player.id === 'hero').currency
  const balanceCp = purse.copper + purse.silver * 10 + purse.gold * 100 + purse.platinum * 1_000
  assert.equal(balanceCp, 20_000 - 2_000, 'кошелёк списан ровно на виру')

  // Повтор того же ключа не платит второй раз.
  const repeat = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'law-fine',
      command: { command_type: 'ResolveGuardEncounter', actor_id: 'hero', resolution: 'fine' },
    },
  })
  assert.equal(repeat.status, 200, repeat.text)
  const after = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  const repeatPurse = after.body.state.players.find((player) => player.id === 'hero').currency
  assert.equal(
    repeatPurse.copper + repeatPurse.silver * 10 + repeatPurse.gold * 100 + repeatPurse.platinum * 1_000,
    balanceCp,
    'повтор с тем же ключом идемпотентен',
  )
})

test('побег от стражи идёт двухфазным ручным броском и принимает только свой кубик', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  // Первая фаза: сервер объявляет проверку и ничего не коммитит.
  const announced = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'law-flee-phase-1',
      manual_roll: true,
      command: { command_type: 'ResolveGuardEncounter', actor_id: 'hero', resolution: 'flee', skill: 'stealth' },
    },
  })
  assert.equal(announced.status, 200, `${announced.text}\n${log()}`)
  assert.ok(announced.body.check?.check_id, `сервер обязан вернуть карточку проверки\n${announced.text}`)
  assert.equal(announced.body.check.sides, 20)
  assert.equal(announced.body.check.difficulty, 9, 'СЛ — пассивное Восприятие стражи, объявленное сервером')
  assert.equal(announced.body.check.modifier, 8, 'модификатор берётся у той же превью-функции, что и у движка')

  const beforeRoll = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.ok(beforeRoll.body.state.law.encounter, 'до броска стража остаётся на месте')

  // Чужой бросок того же героя во вторую фазу не проходит.
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
      idempotency_key: 'law-flee-foreign',
      roll: { roll_id: foreign.body.roll_id },
      command: { command_type: 'ResolveGuardEncounter', actor_id: 'hero', resolution: 'flee', skill: 'stealth' },
    },
  })
  assert.equal(rejected.status, 400, rejected.text)
  assert.equal(rejected.body.code, 'ROLL_CONTEXT_MISMATCH')

  // Кубик бросает игрок — но через серверный реестр.
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
      idempotency_key: 'law-flee-phase-2',
      roll: { roll_id: rolled.body.roll_id },
      command: { command_type: 'ResolveGuardEncounter', actor_id: 'hero', resolution: 'flee', skill: 'stealth' },
    },
  })
  assert.equal(resolved.status, 200, `${resolved.text}\n${log()}`)
  const escape = (resolved.body.mechanics ?? []).find((event) => event.event_type === 'GuardEncounterResolved')
  assert.ok(escape, `побег не создал события\n${resolved.text}`)
  assert.equal(escape.payload.checks[0].total, rolled.body.total, 'движок считает по броску игрока, а не бросает заново')
  assert.equal(escape.payload.success, true, 'на посеянном состоянии побег проходит при любом кубике')

  const room = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.equal(room.body.state.law.encounter ?? null, null, 'ушли — стражи перед отрядом больше нет')
  const north = room.body.state.law.regions.find((region) => region.region_id === REGION)
  assert.equal(north.level, 2, 'закон не забывает того, кто сбежал')
  assert.equal(north.crimes[0].cleared_at_minutes ?? null, null)
})

test('игроку не приходит ни ступень розыска, ни реестр преступлений', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const registered = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Игрок', email: 'player@law.test', password: 'very-secure-player-password' },
  })
  assert.equal(registered.status, 201, `${registered.text}\n${log()}`)
  const playerCookie = cookie(registered)

  const invited = await request(baseUrl, `/api/campaigns/${SESSION}/invites`, {
    method: 'POST', cookie: adminCookie, body: { hero_ids: ['hero'] },
  })
  assert.equal(invited.status, 201, `${invited.text}\n${log()}`)
  const joined = await request(baseUrl, `/api/campaigns/${SESSION}/join`, {
    method: 'POST', cookie: playerCookie, body: { invite_token: invited.body.token },
  })
  assert.equal(joined.status, 200, `${joined.text}\n${log()}`)

  const room = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: playerCookie })
  assert.equal(room.status, 200, `${room.text}\n${log()}`)
  const law = room.body.state.law
  assert.ok(law.encounter, 'офицер перед отрядом игроку виден')
  assert.equal(law.encounter.level, undefined, 'а точной ступени — нет')
  assert.equal(law.regions, undefined)
  assert.equal(law.crimes, undefined)
  assert.ok((law.signs ?? []).length > 0, 'вместо цифры игрок получает приметы мира')
  assert.ok(!JSON.stringify(law).includes('"points"'))

  // Проекция состояния — только половина ответа. Ревью 2026-08-09 поймало, что
  // те же числа уезжали игроку **каналом событий** той же команды: ответ на
  // POST /commands нёс `GuardEncounterResolved` со ступенью и `WantedCleared`
  // со `level_before` и полным списком `crime_ids`.
  const paid = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: playerCookie,
    body: {
      idempotency_key: 'law-player-fine',
      command: { command_type: 'ResolveGuardEncounter', actor_id: 'hero', resolution: 'fine' },
    },
  })
  assert.equal(paid.status, 200, `${paid.text}\n${log()}`)
  const events = paid.body.mechanics ?? []
  assert.ok(events.some((event) => event.event_type === 'GuardEncounterResolved'), `сам исход игроку виден\n${paid.text}`)
  const serialized = JSON.stringify(events)
  assert.ok(!serialized.includes('"level"'), `ступень розыска уехала игроку событием: ${serialized}`)
  assert.ok(!serialized.includes('level_before'), `ступень до снятия уехала игроку событием: ${serialized}`)
  assert.ok(!serialized.includes('crime_ids'), `реестр преступлений уехал игроку событием: ${serialized}`)
  assert.ok(!events.some((event) => event.event_type === 'WantedLevelRaised'), 'gm_only событий у игрока нет вовсе')

  // Ведущему провенанс остаётся целиком: он и решает по числам.
  const master = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  const north = master.body.state.law.regions.find((region) => region.region_id === REGION)
  assert.equal(north.level, 0)
  assert.equal(north.crimes[0].cleared_reason, 'fine')
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Обыск доступен настоящему игроку через основной сайт, а не только движку.
 *
 * Проба ходит теми же путями, что и браузер: один POST в
 * `/api/campaigns/:code/commands` на обыск, чтение комнаты — обычным GET.
 * Отдельно проверяются три вещи, которых движку не видно: повтор с тем же
 * ключом, чужой ключ и гонка двух игроков за один и тот же кинжал.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const SESSION = 'LOOT-API'
const PLACE = 'Разграбленный склад'
const CONTAINER_ID = 'loot:corpse:seeded'

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

function instance(id, { catalogId, name, weight, quantity = 1, type = 'weapon' }) {
  return {
    schema_version: 1,
    item_instance_id: id,
    catalog_id: catalogId,
    snapshot: {
      catalog_id: catalogId,
      catalog_schema_version: 'srd_5_2_1',
      name,
      type,
      weight,
      description: name,
      base_price_cp: 100,
      mechanics_status: 'partial',
    },
    quantity,
    equipped: false,
    owner: { kind: 'container', actor_id: CONTAINER_ID },
    origin: { kind: 'enemy_loadout', template_id: 'srd_5_2_1:bandit', source_id: 'enc-1' },
    lootable: true,
  }
}

const DAGGER = instance('foe-1-item-1', { catalogId: 'srd_5_2_1:dagger', name: 'Кинжал', weight: 1 })
const BOLTS = instance('foe-1-item-2', { catalogId: 'srd_5_2_1:bolts-20', name: 'Болты (20)', weight: 1.5, quantity: 2, type: 'gear' })

/** Бой отыгран: тело лежит в клетке рядом с героем, добыча ещё не взята. */
function seededState() {
  return {
    sessionCode: SESSION,
    campaign: 'Контейнеры добычи',
    partyName: 'Отряд героев',
    partyMemberIds: ['hero', 'mate'],
    activePlayerId: 'hero',
    engine_mode: 'enforce',
    isNarrating: false,
    pendingCheck: null,
    messages: [],
    scene: {
      title: PLACE, location: PLACE, location_id: 'warehouse', mood: '', objective: '', turn: 0,
      cells: Array.from({ length: 36 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })),
    },
    players: [
      {
        id: 'hero', name: 'Player', character: 'Ада', hp: 10, maxHp: 10, armor: 12, x: 1, y: 1,
        abilities: { str: 16, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        proficiency: 2, inventory: [], online: true,
      },
      {
        id: 'mate', name: 'Player', character: 'Борх', hp: 10, maxHp: 10, armor: 12, x: 5, y: 5,
        abilities: { str: 16, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        proficiency: 2, inventory: [], online: true,
      },
    ],
    worldMap: { seed: 'loot-api', locations: [{ id: 'warehouse', name: PLACE, kind: 'ruin', x: 100, y: 300 }], routes: [] },
    mechanics: { world_time: { amount: 60, unit: 'minute', elapsed_minutes: 60 } },
    loot_containers: {
      schema_version: 1,
      containers: [{
        schema_version: 1,
        policy_id: 'skazanie:loot-containers-v1',
        id: CONTAINER_ID,
        kind: 'corpse',
        source_enemy_id: 'foe-1',
        source_enemy_ids: ['foe-1'],
        encounter_id: 'enc-1',
        name: 'Тело: Разбойник',
        location_id: 'warehouse',
        location_name: PLACE,
        x: 1,
        y: 2,
        status: 'available',
        created_at_minutes: 60,
        items: [DAGGER, BOLTS],
      }],
    },
  }
}

async function setUp(t) {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-loot-api-'))
  const setupToken = 'loot-api-setup-token'
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
    body: { name: 'Loot Admin', email: 'admin@loot.test', password: 'very-secure-admin-password', setupToken },
  })
  assert.equal(setup.status, 201, `${setup.text}\n${log()}`)
  const adminCookie = cookie(setup)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: SESSION, name: 'Добыча', state: seededState() },
  })
  assert.equal(created.status, 201, `${created.text}\n${log()}`)
  return { baseUrl, adminCookie, log }
}

const loot = (extra = {}) => ({
  command_type: 'LootContainer',
  actor_id: 'hero',
  container_id: CONTAINER_ID,
  lines: [{ item_instance_id: DAGGER.item_instance_id, quantity: 1 }],
  ...extra,
})

test('игрок обыскивает тело через обычный маршрут команд', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const before = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.equal(before.status, 200, `${before.text}\n${log()}`)

  const taken = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: adminCookie, body: { idempotency_key: 'loot-1', command: loot() },
  })
  assert.equal(taken.status, 200, `${taken.text}\n${log()}`)
  const event = (taken.body.mechanics ?? []).find((candidate) => candidate.event_type === 'LootContainerTaken')
  assert.ok(event, `обыск не создал события\n${taken.text}`)
  assert.equal(event.payload.container_id, CONTAINER_ID)
  assert.equal(event.payload.items.length, 1)
  // Здесь ходит ведущий, и санитайзер событий его намеренно не режет; сторож
  // игрока — `test/loot-containers.test.mjs`, где тот же поток читается
  // `mechanicsForViewer` от лица игрока.
  assert.equal(event.payload.status_after, 'available')

  const room = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  const hero = room.body.state.players.find((player) => player.id === 'hero')
  assert.equal(hero.inventory.length, 1)
  assert.equal(hero.inventory[0].catalog_id, 'srd_5_2_1:dagger')
  const container = room.body.state.loot_containers.containers.find((entry) => entry.id === CONTAINER_ID)
  assert.equal(container.item_count, 1, 'кинжал ушёл, болты остались')

  // Повтор с тем же ключом возвращает прежний результат, а не второй кинжал.
  const replay = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: adminCookie, body: { idempotency_key: 'loot-1', command: loot() },
  })
  assert.equal(replay.status, 200, `${replay.text}\n${log()}`)
  const afterReplay = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.equal(afterReplay.body.state.players.find((player) => player.id === 'hero').inventory.length, 1)
})

test('чужой ключ не раскрывает чужой результат', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const first = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: adminCookie, body: { idempotency_key: 'shared-key', command: loot() },
  })
  assert.equal(first.status, 200, `${first.text}\n${log()}`)

  const foreign = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'shared-key',
      command: loot({ lines: [{ item_instance_id: BOLTS.item_instance_id, quantity: 1 }] }),
    },
  })
  assert.equal(foreign.status, 409, foreign.text)
  assert.equal(foreign.body.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal(foreign.text.includes(DAGGER.item_instance_id), false, 'чужой результат не должен просвечивать в отказе')

  // Болты никуда не делись: чужой ключ ничего не исполнил.
  const room = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.equal(room.body.state.loot_containers.containers[0].item_count, 1)
})

test('гонка за один предмет так, как ходит браузер: 400 и свежий список', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  // Живой клиент версию не присылает вовсе: `normalizeCommand` подставляет туда
  // текущую, поэтому `STATE_VERSION_CONFLICT` браузеру не достаётся никогда.
  // Настоящий исход гонки — 400 с `LOOT_ITEM_GONE`, и свежий список нужен
  // именно ему: иначе карточка проигравшего показывала бы уже взятый кинжал до
  // следующего опроса комнаты.
  const first = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: adminCookie, body: { idempotency_key: 'plain-1', command: loot() },
  })
  assert.equal(first.status, 200, `${first.text}\n${log()}`)

  const second = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: adminCookie, body: { idempotency_key: 'plain-2', command: loot() },
  })
  assert.equal(second.status, 400, second.text)
  assert.equal(second.body.code, 'LOOT_ITEM_GONE')
  assert.ok(second.body.loot_containers, 'отказ обязан принести свежий список и без конфликта версии')
  const fresh = second.body.loot_containers.containers.find((entry) => entry.id === CONTAINER_ID)
  assert.equal(fresh.item_count, 1, 'свежий список показывает, что кинжала уже нет')
  assert.equal(fresh.items.some((item) => item.item_instance_id === DAGGER.item_instance_id), false)
  assert.ok(second.body.state_version > 0)

  // Список объясняет «чего уже нет», но не «кто успел»: имя лежит в летописи, и
  // она доезжает до браузера следующим опросом комнаты — то есть после того,
  // как свежий список уже убрал карточку с экрана. Поэтому сервер кладёт запись
  // в тот же отказ (`vanishedLootFrom`, `src/loot-panel-rules.mjs`).
  assert.ok(second.body.loot_taken, 'отказ обязан назвать и того, кто забрал')
  assert.equal(second.body.loot_taken.type, 'loot-taken')
  assert.equal(second.body.loot_taken.containerId, CONTAINER_ID)
  assert.equal(second.body.loot_taken.recipientId, 'hero')
  assert.equal(second.body.loot_taken.statusAfter, 'available', 'болты ещё лежат — тело не опустело')
  assert.equal(second.text.includes(DAGGER.item_instance_id), false, 'запись летописи содержимого не открывает')

  // А теперь тело обирают дочиста: проигравший гонку обязан прочитать «уже
  // забрал такой-то» вместо молча пропавшей карточки, и признак опустошения
  // приезжает тем же отказом.
  const rest = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'plain-3',
      command: loot({ lines: [{ item_instance_id: BOLTS.item_instance_id, quantity: BOLTS.quantity }] }),
    },
  })
  assert.equal(rest.status, 200, `${rest.text}\n${log()}`)

  const late = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: adminCookie, body: { idempotency_key: 'plain-4', command: loot() },
  })
  assert.equal(late.status, 400, late.text)
  assert.equal(late.body.code, 'LOOT_CONTAINER_EMPTY')
  assert.equal(
    late.body.loot_containers.containers.some((entry) => entry.id === CONTAINER_ID), false,
    'опустошённое тело уходит из проекции — именно это и заводит призрака',
  )
  assert.equal(late.body.loot_taken.statusAfter, 'emptied')
  assert.equal(late.body.loot_taken.remainingCount, 0)
  assert.equal(late.body.loot_taken.recipientId, 'hero')
})

test('гонка за один предмет: второй получает конфликт версии и свежий список', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const before = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  const staleVersion = Number(before.body.state.state_version ?? 0)

  const first = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: { idempotency_key: 'race-1', command: loot({ expected_state_version: staleVersion }) },
  })
  assert.equal(first.status, 200, `${first.text}\n${log()}`)

  const second = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: { idempotency_key: 'race-2', command: loot({ expected_state_version: staleVersion }) },
  })
  assert.equal(second.status, 409, second.text)
  assert.equal(second.body.code, 'STATE_VERSION_CONFLICT')
  assert.ok(second.body.loot_containers, 'отказ обязан принести свежий список')
  assert.ok(second.body.state_version > staleVersion)
  const fresh = second.body.loot_containers.containers.find((entry) => entry.id === CONTAINER_ID)
  assert.equal(fresh.item_count, 1, 'свежий список показывает, что кинжала уже нет')
  assert.equal(fresh.items.some((item) => item.item_instance_id === DAGGER.item_instance_id), false)
})

test('содержимое тела приходит только тому, чей герой стоит рядом', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const nearby = await request(baseUrl, `/api/rooms/${SESSION}?actor_id=hero`, { cookie: adminCookie })
  assert.equal(nearby.status, 200, `${nearby.text}\n${log()}`)
  // Ведущий видит содержимое всегда — у него нет героя, которым можно подойти.
  assert.ok(nearby.body.state.loot_containers.containers[0].items)

  const far = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: { idempotency_key: 'far-1', command: loot({ actor_id: 'mate' }) },
  })
  assert.equal(far.status, 400, far.text)
  assert.equal(far.body.code, 'LOOT_CONTAINER_OUT_OF_REACH')
})

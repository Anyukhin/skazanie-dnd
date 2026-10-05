import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'
import { SLAB_MAX_INSTANCES } from '../server/talespire-slab.mjs'
import { ASSETS, HOUSE_SLAB, encodeSlabV1, encodeSlabV1Raw, encodeSlabV2, housePlacements } from './talespire-fixtures.mjs'
import { deserializeTacticalMap } from '../server/tactical-map.mjs'

/**
 * HTTP-путь импорта карты из TaleSpire: `POST /api/campaigns/:id/map-import`.
 * Предпросмотр ничего не пишет, применение идёт командой через общий
 * исполнитель, повтор ключа возвращает прежний коммит, а чужой игрок и
 * обходной путь через `/commands` получают отказ.
 */

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: 'map-import-setup',
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
  await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* сервер ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Server did not become healthy\n${logs()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text }
}

const sessionCookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

/** Тело уходит как есть: `null`, массив, число или битый JSON. */
async function rawRequest(baseUrl, path, { method = 'POST', cookie = '', raw }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: raw,
  })
  const text = await response.text()
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text }
}

test('тело не объект — 400, а сервер жив для следующего запроса (аудит PR #131, MAP-BOUNDARY-03)', { timeout: runnerTimeout(90_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-map-import-body-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  // Обычный аккаунт — ведущий своей кампании, глобальных прав у него нет.
  const owner = await request(baseUrl, '/api/auth/register', { method: 'POST', body: { name: 'Owner', email: 'map-body@test.local', password: 'secure-owner-password' } })
  const ownerCookie = sessionCookie(owner)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: ownerCookie,
    body: { code: 'MAPNUL', name: 'Пустое тело', bootstrap: { partyName: 'Один', players: [{ id: 'hero-1' }] } },
  })
  assert.equal(created.status, 201, created.text)

  const path = '/api/campaigns/MAPNUL/map-import'
  for (const raw of ['null', '[]', '[{"mode":"preview"}]', '42', '"slab"', 'true']) {
    const rejected = await rawRequest(baseUrl, path, { cookie: ownerCookie, raw })
    assert.equal(rejected.status, 400, `${raw}: ${rejected.text}\n${logs}`)
    assert.equal(rejected.body.code, 'INVALID_JSON_BODY', raw)
    assert.equal(child.exitCode, null, `сервер упал на теле ${raw}\n${logs}`)
  }

  // Тот же узкий фикс закрывает и маршруты, где тело читают без try: вход без
  // сессии и индикатор ввода. Битый JSON вне try ловит общая граница HTTP.
  const login = await rawRequest(baseUrl, '/api/auth/login', { raw: 'null' })
  assert.equal(login.status, 401, login.text)
  const typingNull = await rawRequest(baseUrl, '/api/campaigns/MAPNUL/presence/typing', { method: 'PUT', cookie: ownerCookie, raw: 'null' })
  assert.equal(typingNull.status, 400, typingNull.text)
  assert.equal(typingNull.body.code, 'INVALID_JSON_BODY')
  const typingBroken = await rawRequest(baseUrl, '/api/campaigns/MAPNUL/presence/typing', { method: 'PUT', cookie: ownerCookie, raw: '{"typing":' })
  assert.equal(typingBroken.status, 400, typingBroken.text)
  assert.equal(typingBroken.body.code, 'INVALID_JSON')
  // Непредвиденная ошибка маршрута: `{"toString":1}` не приводится к строке,
  // и TypeError уходит из catch маршрута наверх. Граница отвечает 500 и не
  // роняет процесс. Если маршрут научится отказывать сам, триггер нужно сменить.
  const unexpected = await rawRequest(baseUrl, path, { cookie: ownerCookie, raw: JSON.stringify({ mode: 'preview', slab: HOUSE_SLAB, location_id: { toString: 1 } }) })
  assert.equal(unexpected.status, 500, unexpected.text)
  assert.equal(unexpected.body.code, 'INTERNAL_ERROR')
  assert.doesNotMatch(unexpected.text, /toString|primitive|at /u, 'наружу не уходят подробности ошибки')
  assert.equal(child.exitCode, null, `сервер упал\n${logs}`)

  // Сервер продолжает обслуживать: здоровье, комната и настоящий предпросмотр.
  assert.equal((await request(baseUrl, '/api/health')).status, 200)
  const room = await request(baseUrl, '/api/rooms/MAPNUL', { cookie: ownerCookie })
  assert.equal(room.status, 200, room.text)
  const preview = await request(baseUrl, path, { method: 'POST', cookie: ownerCookie, body: { mode: 'preview', slab: HOUSE_SLAB } })
  assert.equal(preview.status, 200, preview.text)
  assert.equal((await request(baseUrl, '/api/rooms/MAPNUL', { cookie: ownerCookie })).body.version, room.body.version, 'отказы ничего не записали')
})

test('импорт карты по HTTP: предпросмотр, применение, повтор ключа и права', { timeout: runnerTimeout(90_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-map-import-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const owner = await request(baseUrl, '/api/auth/register', { method: 'POST', body: { name: 'Owner', email: 'map-owner@test.local', password: 'secure-owner-password' } })
  const guest = await request(baseUrl, '/api/auth/register', { method: 'POST', body: { name: 'Guest', email: 'map-guest@test.local', password: 'secure-guest-password' } })
  const ownerCookie = sessionCookie(owner)
  const guestCookie = sessionCookie(guest)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: ownerCookie,
    body: { code: 'MAPIMP', name: 'Карты из TaleSpire', bootstrap: { partyName: 'Двое', players: [{ id: 'hero-1' }, { id: 'hero-2' }] } },
  })
  assert.equal(created.status, 201, created.text)
  const invite = await request(baseUrl, '/api/campaigns/MAPIMP/invites', { method: 'POST', cookie: ownerCookie, body: { hero_ids: ['hero-2'] } })
  assert.equal(invite.status, 201, invite.text)
  assert.equal((await request(baseUrl, '/api/campaigns/MAPIMP/join', { method: 'POST', cookie: guestCookie, body: { invite_token: invite.body.token } })).status, 200)

  const path = '/api/campaigns/MAPIMP/map-import'
  assert.equal((await request(baseUrl, path, { method: 'POST', body: { slab: HOUSE_SLAB } })).status, 401)
  const guestTry = await request(baseUrl, path, { method: 'POST', cookie: guestCookie, body: { slab: HOUSE_SLAB } })
  assert.equal(guestTry.status, 403, guestTry.text)
  assert.equal(guestTry.body.code, 'MAP_IMPORT_FORBIDDEN')

  const before = await request(baseUrl, '/api/rooms/MAPIMP', { cookie: ownerCookie })
  assert.equal(before.status, 200, before.text)

  // Предпросмотр: этажи и сводка, без записи в журнал.
  const preview = await request(baseUrl, path, { method: 'POST', cookie: ownerCookie, body: { mode: 'preview', slab: HOUSE_SLAB } })
  assert.equal(preview.status, 200, preview.text)
  assert.equal(preview.body.location.current, true)
  assert.deepEqual(preview.body.levels.map((level) => level.index), [0, 1])
  assert.equal(preview.body.stats.doors, 1)
  const unchanged = await request(baseUrl, '/api/rooms/MAPIMP', { cookie: ownerCookie })
  assert.equal(unchanged.body.version, before.body.version, 'предпросмотр не меняет кампанию')

  const garbage = await request(baseUrl, path, { method: 'POST', cookie: ownerCookie, body: { mode: 'preview', slab: 'не слэб' } })
  assert.equal(garbage.status, 400)
  assert.equal(garbage.body.code, 'SLAB_NOT_BASE64')

  // Аудит PR #131, MAP-BOUNDARY-01/02: лавина одинаковых объектов и коробка в
  // сто тысяч клеток укладываются в предел сжатого слэба. Оба — 400 с кодом
  // до обхода геометрии, и в предпросмотре, и в применении.
  const flood = encodeSlabV2(Array.from({ length: SLAB_MAX_INSTANCES + 1 }, () => ({ asset: ASSETS.floor, x: 1, y: 0, z: 1 })))
  const flooded = await request(baseUrl, path, { method: 'POST', cookie: ownerCookie, body: { mode: 'preview', slab: flood } })
  assert.equal(flooded.status, 400, flooded.text)
  assert.equal(flooded.body.code, 'SLAB_TOO_MANY_INSTANCES')
  const floodApply = await request(baseUrl, path, { method: 'POST', cookie: ownerCookie, body: { mode: 'apply', slab: flood, idempotency_key: 'map-import:flood' } })
  assert.equal(floodApply.status, 400, floodApply.text)
  assert.equal(floodApply.body.code, 'SLAB_TOO_MANY_INSTANCES')
  const wide = encodeSlabV1Raw([{ asset: ASSETS.floor, center: [5, 0.25, 5], extent: [100_000, 0.25, 100_000] }])
  const widened = await request(baseUrl, path, { method: 'POST', cookie: ownerCookie, body: { mode: 'preview', slab: wide } })
  assert.equal(widened.status, 400, widened.text)
  assert.equal(widened.body.code, 'SLAB_EXTENT_TOO_LARGE')
  assert.equal((await request(baseUrl, '/api/rooms/MAPIMP', { cookie: ownerCookie })).body.version, before.body.version, 'отказы ничего не записали')

  const keyless = await request(baseUrl, path, { method: 'POST', cookie: ownerCookie, body: { mode: 'apply', slab: HOUSE_SLAB } })
  assert.equal(keyless.status, 400)
  assert.equal(keyless.body.code, 'IDEMPOTENCY_KEY_REQUIRED')

  // Применение к текущей сцене.
  const apply = { mode: 'apply', slab: HOUSE_SLAB, idempotency_key: 'map-import:house-1' }
  const applied = await request(baseUrl, path, { method: 'POST', cookie: ownerCookie, body: apply })
  assert.equal(applied.status, 200, applied.text)
  assert.equal(applied.body.applied_to_scene, true)
  assert.equal(applied.body.duplicate, false)
  assert.deepEqual(applied.body.levels, [{ index: 0, label: 'Первый этаж' }, { index: 1, label: 'Второй этаж' }])
  assert.equal(applied.body.state.scene.map.generator.id, 'talespire-slab')

  // Безопасное обновление меняет только покрытие: геометрия, туман и позиции
  // остаются прежними, а owner route возвращает явный режим операции.
  const refreshBefore = await request(baseUrl, '/api/rooms/MAPIMP', { cookie: ownerCookie })
  const refreshBeforeMap = deserializeTacticalMap(refreshBefore.body.state.scene.map)
  const guestRefresh = await request(baseUrl, path, {
    method: 'POST', cookie: guestCookie,
    body: { mode: 'rebuild', preserve_layout: true, idempotency_key: 'map-refresh:guest' },
  })
  assert.equal(guestRefresh.status, 403, guestRefresh.text)
  const refresh = await request(baseUrl, path, {
    method: 'POST', cookie: ownerCookie,
    body: { mode: 'rebuild', preserve_layout: true, idempotency_key: 'map-refresh:floors-1' },
  })
  assert.equal(refresh.status, 200, refresh.text)
  assert.equal(refresh.body.preserve_layout, true)
  const refreshAfterMap = deserializeTacticalMap(refresh.body.state.scene.map)
  assert.deepEqual(refreshAfterMap.doors, refreshBeforeMap.doors)
  assert.deepEqual(refreshAfterMap.edges, refreshBeforeMap.edges)
  assert.deepEqual(refreshAfterMap.props, refreshBeforeMap.props)
  assert.deepEqual(refreshAfterMap.layers.revealed, refreshBeforeMap.layers.revealed)
  assert.deepEqual(refresh.body.state.players.map((player) => ({ id: player.id, x: player.x, y: player.y })),
    refreshBefore.body.state.players.map((player) => ({ id: player.id, x: player.x, y: player.y })))

  // Повтор того же ключа — прежний коммит, а не второй импорт.
  const repeated = await request(baseUrl, path, { method: 'POST', cookie: ownerCookie, body: apply })
  assert.equal(repeated.status, 200, repeated.text)
  assert.equal(repeated.body.duplicate, true)
  assert.equal(repeated.body.version, refresh.body.version)
  const refreshConflict = await request(baseUrl, path, {
    method: 'POST', cookie: ownerCookie,
    body: { mode: 'rebuild', preserve_layout: false, idempotency_key: 'map-refresh:floors-1' },
  })
  assert.equal(refreshConflict.status, 409, refreshConflict.text)
  assert.equal(refreshConflict.body.code, 'IDEMPOTENCY_CONFLICT')
  const conflicting = await request(baseUrl, path, { method: 'POST', cookie: ownerCookie, body: { ...apply, slab: encodeSlabV1(housePlacements()) } })
  assert.equal(conflicting.status, 409, conflicting.text)
  assert.equal(conflicting.body.code, 'IDEMPOTENCY_CONFLICT')

  // Игрок видит новую карту сцены через обычную проекцию.
  const guestRoom = await request(baseUrl, '/api/rooms/MAPIMP', { cookie: guestCookie })
  assert.equal(guestRoom.status, 200, guestRoom.text)
  assert.equal(guestRoom.body.state.scene.map.generator.id, 'talespire-slab')

  // Обходной путь через общий маршрут команд закрыт движком.
  const bypass = await request(baseUrl, '/api/campaigns/MAPIMP/commands', {
    method: 'POST',
    cookie: ownerCookie,
    body: { idempotency_key: 'map-import:bypass', message: 'импорт в обход', command: { command_type: 'ImportLocationMap', actor_id: 'hero-1', slab: HOUSE_SLAB } },
  })
  assert.ok(bypass.status >= 400, `обход должен отклоняться: ${bypass.status} ${bypass.text}`)
  const after = await request(baseUrl, '/api/rooms/MAPIMP', { cookie: ownerCookie })
  assert.equal(after.body.version, refresh.body.version, 'отказ обходного пути ничего не записал')

  // Этап 8: перестройка карты текущей сцены по программе — тем же маршрутом.
  const rebuild = { mode: 'rebuild', text: 'В центре двора колодец, у стены — три бочки.', idempotency_key: 'map-rebuild:1' }
  const guestRebuild = await request(baseUrl, path, { method: 'POST', cookie: guestCookie, body: rebuild })
  assert.equal(guestRebuild.status, 403, guestRebuild.text)
  const rebuilt = await request(baseUrl, path, { method: 'POST', cookie: ownerCookie, body: rebuild })
  assert.equal(rebuilt.status, 200, rebuilt.text)
  assert.equal(rebuilt.body.mode, 'rebuild')
  assert.equal(rebuilt.body.duplicate, false)
  assert.notEqual(rebuilt.body.state.scene.map.generator.id, 'talespire-slab', 'карта построена генератором заново')
  assert.equal(rebuilt.body.state.scene.map_source, undefined)
  const rebuiltAgain = await request(baseUrl, path, { method: 'POST', cookie: ownerCookie, body: rebuild })
  assert.equal(rebuiltAgain.body.duplicate, true, 'повтор ключа — прежний коммит')
  assert.equal(rebuiltAgain.body.version, rebuilt.body.version)
  const rebuildBypass = await request(baseUrl, '/api/campaigns/MAPIMP/commands', {
    method: 'POST',
    cookie: ownerCookie,
    body: { idempotency_key: 'map-rebuild:bypass', message: 'перестройка в обход', command: { command_type: 'RebuildLocationMap', actor_id: 'hero-1' } },
  })
  assert.ok(rebuildBypass.status >= 400, `обход перестройки отклоняется: ${rebuildBypass.status}`)
})

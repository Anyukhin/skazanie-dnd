import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Аудит PR #131, LIVE-01/02. Живой поток комнаты раньше проверял права один раз
 * — на рукопожатии — и дальше жил снимком: после logout или истечения сессии
 * продолжал получать комнату, а после переназначения героя отдавал проекцию
 * прежнего героя, хотя свежий GET её уже скрывал. Тест поднимает настоящий
 * сервер на временном хранилище и проверяет всё по HTTP:
 *
 * - logout закрывает поток именно этой сессии, второй вход того же игрока живёт;
 * - истёкшая сессия теряет поток на ближайшей рассылке и пропадает из присутствия;
 * - после смены героев поток отдаёт ту же проекцию, что свежий GET;
 * - потеря доступа к кампании закрывает поток.
 */

function startServer(port, storage, emptyEnv, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      DOTENV_CONFIG_PATH: emptyEnv, ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'live-access-setup',
      COOKIE_SECURE: 'false', NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited\n${logs()}`)
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return
    } catch { /* сервер ещё стартует */ }
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
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* в диагностике хватит текста */ }
  return { response, status: response.status, body: parsed, text }
}

function sessionCookie(result) {
  const value = result.response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(value, 'ответ не выдал cookie сессии')
  return value
}

function hero(id, name, origin) {
  return {
    id, character: name, name, hp: 12, maxHp: 12, armor: 10, speed: 30, proficiency: 2,
    abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    inventory: [{
      id: `${id}-blade`, catalog_id: 'srd_5_2_1:longsword', name: `${name}: клинок`,
      type: 'weapon', quantity: 1, weight: 3, origin, equipped: false,
    }],
  }
}

/**
 * Кампания без явного членства: доступ даёт `user.heroIds`, который правит
 * администратор. Происхождение `stolen` — приватное поле: своё видно, чужое
 * проекция вырезает. На нём и видно, чьими глазами построен кадр.
 */
function legacyCampaignState(code) {
  return {
    sessionCode: code, campaign: `Живой доступ ${code}`, partyName: 'Двое',
    activePlayerId: 'hero-1', partyMemberIds: ['hero-1', 'hero-2'], messages: [],
    players: [hero('hero-1', 'Первый', 'stolen'), hero('hero-2', 'Второй', 'found')],
    scene: { title: 'Зал', location: 'Зал', mood: '', objective: '', turn: 1, cells: [] },
    adventure: { chapter: 1, visitedLocations: ['Зал'], history: [] },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'],
    state_version: 0,
  }
}

async function openStream(baseUrl, campaignId, cookie, signal) {
  const response = await fetch(`${baseUrl}/api/campaigns/${campaignId}/stream`, {
    headers: { Cookie: cookie, Accept: 'text/event-stream' }, signal,
  })
  if (response.status !== 200) throw new Error(`SSE ${campaignId}: ${response.status} ${await response.text()}`)
  return { reader: response.body.getReader(), decoder: new TextDecoder(), buffer: '', queued: [], done: false }
}

async function readMore(stream, deadline) {
  let timeout
  const read = await Promise.race([
    stream.reader.read(),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('SSE timeout')), Math.max(1, deadline - Date.now())) }),
  ]).finally(() => clearTimeout(timeout))
  if (read.done) {
    stream.done = true
    return
  }
  stream.buffer += stream.decoder.decode(read.value, { stream: true })
  const blocks = stream.buffer.split(/\r?\n\r?\n/u)
  stream.buffer = blocks.pop() ?? ''
  for (const block of blocks) {
    const event = /^event: ([^\r\n]+)$/mu.exec(block)?.[1] ?? ''
    const data = block.split(/\r?\n/u).filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
    if (event && data) stream.queued.push({ event, payload: JSON.parse(data) })
  }
}

/** Следующее подходящее событие; `null` — поток закрыт сервером. */
async function nextEvent(stream, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    while (stream.queued.length) {
      const item = stream.queued.shift()
      if (predicate(item)) return item
    }
    if (stream.done) return null
    if (Date.now() >= deadline) throw new Error('SSE timeout')
    await readMore(stream, deadline)
  }
}

async function nextRoom(stream, predicate = () => true) {
  const item = await nextEvent(stream, (candidate) => candidate.event === 'room' && predicate(candidate.payload))
  assert.ok(item, 'поток закрылся раньше, чем пришёл ожидаемый кадр комнаты')
  return item.payload
}

/**
 * Поток обязан закрыться сервером: последним кадром `access` с причиной, без
 * единой комнаты новее `maxVersion` — ни до отзыва, ни после.
 */
async function expectRevoked(stream, reason, maxVersion) {
  let access = null
  const rooms = []
  const afterAccess = []
  const end = await nextEvent(stream, (item) => {
    if (access) afterAccess.push(item.event)
    else if (item.event === 'access') access = item.payload
    if (item.event === 'room') rooms.push(Number(item.payload.version))
    return false
  })
  assert.equal(end, null, 'поток отозванной сессии не закрыт')
  assert.deepEqual(access, { status: 'revoked', reason })
  assert.deepEqual(afterAccess, [], 'после отзыва в поток ещё что-то пришло')
  assert.ok(rooms.every((version) => version <= maxVersion), `отозванный поток получил комнату новее ${maxVersion}: ${rooms}`)
}

/** Истекает ровно одна сессия — по хешу её токена, как и хранит её сервер. */
function expireSession(storage, cookie) {
  const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const file = join(storage, 'auth.json')
  const auth = JSON.parse(readFileSync(file, 'utf8'))
  const session = auth.sessions.find((candidate) => candidate.tokenHash === tokenHash)
  assert.ok(session, 'сессия для истечения не найдена')
  session.expiresAt = Date.now() - 1
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(auth, null, 2), 'utf8')
  renameSync(temporary, file)
}

async function bootServer(t, prefix) {
  const storage = mkdtempSync(join(tmpdir(), prefix))
  const emptyEnv = join(storage, '.env.empty')
  writeFileSync(emptyEnv, '', 'utf8')
  let logs = ''
  const aborts = []
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = startServer(port, storage, emptyEnv, (chunk) => { logs += chunk })
  t.after(async () => {
    for (const controller of aborts) controller.abort()
    if (child.exitCode == null) await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
    rmSync(storage, { recursive: true, force: true })
  })
  await waitForHealth(baseUrl, child, () => logs)
  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Ведущий', email: 'live-admin@test.local', password: 'secure-live-admin-password', setupToken: 'live-access-setup' },
  })
  assert.equal(admin.status, 201, admin.text)
  const adminCookie = sessionCookie(admin)
  return {
    storage,
    baseUrl,
    adminCookie,
    async stream(campaignId, cookie) {
      const controller = new AbortController()
      aborts.push(controller)
      return openStream(baseUrl, campaignId, cookie, controller.signal)
    },
    async createLegacyCampaign(code) {
      const created = await request(baseUrl, '/api/campaigns', {
        method: 'POST', cookie: adminCookie, body: { code, state: legacyCampaignState(code) },
      })
      assert.equal(created.status, 201, created.text)
    },
    async register(email, name) {
      const result = await request(baseUrl, '/api/auth/register', {
        method: 'POST', body: { name, email, password: 'secure-live-player-password' },
      })
      assert.equal(result.status, 201, result.text)
      return { cookie: sessionCookie(result), userId: result.body.user.id, email }
    },
    async login(email) {
      const result = await request(baseUrl, '/api/auth/login', {
        method: 'POST', body: { email, password: 'secure-live-player-password' },
      })
      assert.equal(result.status, 200, result.text)
      return sessionCookie(result)
    },
    async assign(userId, heroIds) {
      const result = await request(baseUrl, `/api/admin/users/${userId}`, {
        method: 'PATCH', cookie: adminCookie, body: { heroIds },
      })
      assert.equal(result.status, 200, result.text)
    },
    async version(code) {
      const room = await request(baseUrl, `/api/rooms/${code}`, { cookie: adminCookie })
      assert.equal(room.status, 200, room.text)
      return Number(room.body.version)
    },
    /** Коммит от администратора: общий бросок кости рассылает новую комнату. */
    async commit(code, playerId, key) {
      const rolled = await request(baseUrl, `/api/rooms/${code}/dice`, {
        method: 'POST', cookie: adminCookie, body: { playerId, sides: 20, idempotency_key: key },
      })
      assert.equal(rolled.status, 200, rolled.text)
    },
  }
}

test('logout и истечение сессии закрывают поток только этого входа', { timeout: runnerTimeout(90_000) }, async (t) => {
  const server = await bootServer(t, 'skazanie-live-session-')
  await server.createLegacyCampaign('LIVSES')
  const first = await server.register('live-first@test.local', 'Первый')
  const firstSecondLogin = await server.login(first.email)
  const second = await server.register('live-second@test.local', 'Второй')
  await server.assign(first.userId, ['hero-1'])
  await server.assign(second.userId, ['hero-2'])

  const firstA = await server.stream('LIVSES', first.cookie)
  const firstB = await server.stream('LIVSES', firstSecondLogin)
  const observer = await server.stream('LIVSES', second.cookie)
  const bothOnline = (room) => JSON.stringify(room.state.presence.online_hero_ids) === JSON.stringify(['hero-1', 'hero-2'])
  for (const stream of [firstA, firstB, observer]) await nextRoom(stream, bothOnline)

  // Logout первого входа: его поток закрыт сразу, второй вход того же игрока жив.
  const beforeLogout = await server.version('LIVSES')
  const logout = await request(server.baseUrl, '/api/auth/logout', { method: 'POST', cookie: first.cookie, body: {} })
  assert.equal(logout.status, 200, logout.text)
  await expectRevoked(firstA, 'session_ended', beforeLogout)
  assert.equal((await request(server.baseUrl, '/api/auth/me', { cookie: first.cookie })).body.user, null)
  assert.equal((await request(server.baseUrl, '/api/auth/me', { cookie: firstSecondLogin })).body.user?.id, first.userId)

  await server.commit('LIVSES', 'hero-2', 'live-after-logout')
  const afterLogout = await nextRoom(firstB, (room) => Number(room.version) > beforeLogout)
  assert.ok(afterLogout.state.presence.online_hero_ids.includes('hero-1'), 'второй вход того же игрока выпал из присутствия')
  await nextRoom(observer, (room) => Number(room.version) > beforeLogout)

  // Истечение второго входа: события об этом нет, поток закрывает ближайшая
  // рассылка — и она же уже не считает героя в сети.
  const beforeExpiry = await server.version('LIVSES')
  expireSession(server.storage, firstSecondLogin)
  assert.equal((await request(server.baseUrl, '/api/auth/me', { cookie: firstSecondLogin })).body.user, null)
  await server.commit('LIVSES', 'hero-2', 'live-after-expiry')
  await expectRevoked(firstB, 'session_ended', beforeExpiry)
  const afterExpiry = await nextRoom(observer, (room) => Number(room.version) > beforeExpiry)
  assert.deepEqual(afterExpiry.state.presence.online_hero_ids, ['hero-2'])
  assert.equal(afterExpiry.state.players.find((player) => player.id === 'hero-1')?.online, false)

  // Переподключиться истёкшей сессией нельзя: отказ на рукопожатии.
  const reconnect = await fetch(`${server.baseUrl}/api/campaigns/LIVSES/stream`, { headers: { Cookie: firstSecondLogin } })
  assert.equal(reconnect.status, 401)
  await reconnect.body?.cancel()
})

test('после смены героя поток отдаёт ту же проекцию, что свежий GET', { timeout: runnerTimeout(90_000) }, async (t) => {
  const server = await bootServer(t, 'skazanie-live-reassign-')
  await server.createLegacyCampaign('LIVHER')
  const player = await server.register('live-reassign@test.local', 'Игрок')
  await server.assign(player.userId, ['hero-1'])

  const stream = await server.stream('LIVHER', player.cookie)
  const initial = await nextRoom(stream)
  const heroOne = (room) => room.state.players.find((candidate) => candidate.id === 'hero-1')
  // Опора теста: приватное происхождение своего героя видно владельцу.
  assert.equal(heroOne(initial).inventory[0].origin, 'stolen')

  // Администратор переназначает аккаунт на второго героя. Поток обязан
  // перестроиться сразу, без следующего хода.
  await server.assign(player.userId, ['hero-2'])
  const reassigned = await nextRoom(stream, (room) => heroOne(room).inventory[0].origin === undefined)
  assert.deepEqual(reassigned.state.presence.online_hero_ids, ['hero-2'])

  // После коммита кадр потока и свежий GET того же игрока совпадают.
  await server.commit('LIVHER', 'hero-2', 'live-after-reassign')
  const fresh = await request(server.baseUrl, '/api/rooms/LIVHER', { cookie: player.cookie })
  assert.equal(fresh.status, 200, fresh.text)
  assert.equal(heroOne(fresh.body).inventory[0].origin, undefined)
  const streamed = await nextRoom(stream, (room) => Number(room.version) === Number(fresh.body.version))
  // Сцена сравнивается отдельно: поток шлёт карту дельтой по хешу, GET — целиком.
  const { scene: streamedScene, ...streamedRest } = streamed.state
  const { scene: freshScene, ...freshRest } = fresh.body.state
  assert.deepEqual(streamedRest, freshRest)
  assert.equal(streamedScene?.location, freshScene?.location)

  // Потеря доступа к кампании закрывает поток, а не оставляет старую проекцию.
  const beforeRevoke = await server.version('LIVHER')
  await server.assign(player.userId, [])
  await expectRevoked(stream, 'access_lost', beforeRevoke)
  assert.equal((await request(server.baseUrl, '/api/rooms/LIVHER', { cookie: player.cookie })).status, 403)
})

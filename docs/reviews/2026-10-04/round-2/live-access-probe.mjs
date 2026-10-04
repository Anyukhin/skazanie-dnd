import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function freePort() {
  const server = createHttpServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

function diagnosticTail(log) {
  return log.join('').slice(-2_000)
}

function sessionCookie(result) {
  const value = result.response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(value, 'Ответ не выдал session cookie')
  return value
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
  try { parsed = text ? JSON.parse(text) : null } catch { /* В диагностике достаточно status/text. */ }
  return { status: response.status, body: parsed, text, response }
}

function hero(id, name, origin) {
  return {
    id,
    character: name,
    name,
    hp: 12,
    maxHp: 12,
    armor: 10,
    speed: 30,
    proficiency: 2,
    abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    inventory: [{
      id: `${id}-blade`,
      catalog_id: 'srd_5_2_1:longsword',
      name: `${name} blade`,
      type: 'weapon',
      quantity: 1,
      weight: 3,
      origin,
      equipped: false,
    }],
  }
}

function campaignState(code) {
  return {
    sessionCode: code,
    campaign: `Живой доступ ${code}`,
    partyName: 'Пробная группа',
    activePlayerId: 'hero-1',
    partyMemberIds: ['hero-1', 'hero-2'],
    messages: [],
    players: [hero('hero-1', 'Первый герой', 'stolen'), hero('hero-2', 'Второй герой', 'found')],
    scene: { title: 'Зал', location: 'Зал', mood: '', objective: '', turn: 1, cells: [] },
    adventure: { chapter: 1, visitedLocations: ['Зал'], history: [] },
    ruleset_id: 'srd_5_2_1',
    ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'],
    state_version: 0,
  }
}

function startServer(port, storage, emptyEnv, log) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      DOTENV_CONFIG_PATH: emptyEnv,
      ROUTERAI_API_KEY: '',
      ROUTERAI_BASE_URL: '',
      ADMIN_SETUP_TOKEN: 'live-access-probe-setup',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { log.push(String(chunk)) })
  child.stderr.on('data', (chunk) => { log.push(String(chunk)) })
  return child
}

async function waitForHealth(baseUrl, child, log) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Сервер завершился до health-check:\n${diagnosticTail(log)}`)
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return
    } catch { /* Сервер запускается. */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Сервер не ответил на health-check:\n${diagnosticTail(log)}`)
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  let exited = false
  let resolveExit
  const exit = new Promise((resolve) => { resolveExit = resolve })
  child.once('exit', () => { exited = true; resolveExit() })
  child.kill()
  await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5_000))])
  if (!exited) {
    child.kill('SIGKILL')
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 2_000))])
  }
  if (!exited) throw new Error('Пробный сервер не завершился; временное хранилище оставлено для диагностики')
}

async function openStream(baseUrl, campaignId, cookie, signal) {
  const response = await fetch(`${baseUrl}/api/campaigns/${campaignId}/stream`, {
    headers: { Cookie: cookie, Accept: 'text/event-stream' },
    signal,
  })
  if (response.status !== 200) throw new Error(`SSE handshake ${campaignId}: ${await response.text()}`)
  return { reader: response.body.getReader(), decoder: new TextDecoder(), buffer: '', queued: [] }
}

function parseSse(stream) {
  const blocks = stream.buffer.split(/\r?\n\r?\n/u)
  stream.buffer = blocks.pop() ?? ''
  for (const block of blocks) {
    const event = /^event: ([^\r\n]+)$/mu.exec(block)?.[1] ?? ''
    const data = block.split(/\r?\n/u)
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('\n')
    if (event && data) stream.queued.push({ event, payload: JSON.parse(data) })
  }
}

async function nextRoom(stream, predicate = () => true, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    while (stream.queued.length) {
      const item = stream.queued.shift()
      if (item.event === 'room' && predicate(item.payload)) return item.payload
    }
    const remaining = Math.max(1, deadline - Date.now())
    let timeout
    const read = await Promise.race([
      stream.reader.read(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('SSE room event timeout')), remaining) }),
    ]).finally(() => clearTimeout(timeout))
    if (read.done) throw new Error('SSE stream closed before room event')
    stream.buffer += stream.decoder.decode(read.value, { stream: true })
    parseSse(stream)
  }
  throw new Error('SSE room event timeout')
}

async function createCampaign(baseUrl, adminCookie, code) {
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: adminCookie,
    body: { code, state: campaignState(code) },
  })
  assert.equal(created.status, 201, `${code}: ${created.text}`)
}

async function register(baseUrl, email, name) {
  const result = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name, email, password: 'secure-live-access-password' },
  })
  assert.equal(result.status, 201, result.text)
  return { cookie: sessionCookie(result), userId: result.body.user.id }
}

async function assign(baseUrl, adminCookie, userId, heroIds) {
  const result = await request(baseUrl, `/api/admin/users/${userId}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds },
  })
  assert.equal(result.status, 200, result.text)
}

async function triggerRoomBroadcast(baseUrl, adminCookie, campaignId, playerId, key) {
  const result = await request(baseUrl, `/api/rooms/${campaignId}/dice`, {
    method: 'POST',
    cookie: adminCookie,
    body: { playerId, sides: 20, idempotency_key: key },
  })
  assert.equal(result.status, 200, `${campaignId}: ${result.text}`)
}

function expireSession(storage, userId) {
  // Инъекция истёкших часов только в отдельный временный auth-файл пробника;
  // рабочие session и системные часы процесса не меняются.
  const file = join(storage, 'auth.json')
  const auth = JSON.parse(readFileSync(file, 'utf8'))
  const session = auth.sessions.find((candidate) => candidate.userId === userId)
  assert.ok(session, 'Не найдена session запись для probe')
  session.expiresAt = Date.now() - 1
  writeFileSync(file, JSON.stringify(auth, null, 2), 'utf8')
}

async function run() {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-live-access-'))
  const emptyEnv = join(storage, '.env.empty')
  writeFileSync(emptyEnv, '', 'utf8')
  const streams = []
  const log = []
  let child = null
  try {
    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    child = startServer(port, storage, emptyEnv, log)
    await waitForHealth(baseUrl, child, log)

    const admin = await request(baseUrl, '/api/auth/setup-admin', {
      method: 'POST',
      body: { name: 'Probe admin', email: 'live-access-admin@test.invalid', password: 'secure-live-access-password', setupToken: 'live-access-probe-setup' },
    })
    assert.equal(admin.status, 201, admin.text)
    const adminCookie = sessionCookie(admin)

    await createCampaign(baseUrl, adminCookie, 'LIVELOG')
    const logoutPlayer = await register(baseUrl, 'live-access-logout@test.invalid', 'Logout player')
    await assign(baseUrl, adminCookie, logoutPlayer.userId, ['hero-1'])
    const logoutAbort = new AbortController()
    streams.push(logoutAbort)
    const logoutStream = await openStream(baseUrl, 'LIVELOG', logoutPlayer.cookie, logoutAbort.signal)
    const logoutInitial = await nextRoom(logoutStream)
    const logoutResult = await request(baseUrl, '/api/auth/logout', { method: 'POST', cookie: logoutPlayer.cookie, body: {} })
    assert.equal(logoutResult.status, 200, logoutResult.text)
    const logoutMe = await request(baseUrl, '/api/auth/me', { cookie: logoutPlayer.cookie })
    assert.equal(logoutMe.status, 200, logoutMe.text)
    assert.equal(logoutMe.body.user, null, 'logout не аннулировал последующий auth/me')
    await triggerRoomBroadcast(baseUrl, adminCookie, 'LIVELOG', 'hero-1', 'live-access-logout-die')
    const logoutRoom = await nextRoom(logoutStream, (payload) => Number(payload.version) > Number(logoutInitial.version))

    await createCampaign(baseUrl, adminCookie, 'LIVEEXP')
    const expiredPlayer = await register(baseUrl, 'live-access-expiry@test.invalid', 'Expired player')
    await assign(baseUrl, adminCookie, expiredPlayer.userId, ['hero-1'])
    const expiryAbort = new AbortController()
    streams.push(expiryAbort)
    const expiryStream = await openStream(baseUrl, 'LIVEEXP', expiredPlayer.cookie, expiryAbort.signal)
    const expiryInitial = await nextRoom(expiryStream)
    expireSession(storage, expiredPlayer.userId)
    const expiryMe = await request(baseUrl, '/api/auth/me', { cookie: expiredPlayer.cookie })
    assert.equal(expiryMe.status, 200, expiryMe.text)
    assert.equal(expiryMe.body.user, null, 'истёкшая session всё ещё проходит auth/me')
    await triggerRoomBroadcast(baseUrl, adminCookie, 'LIVEEXP', 'hero-1', 'live-access-expiry-die')
    const expiryRoom = await nextRoom(expiryStream, (payload) => Number(payload.version) > Number(expiryInitial.version))

    await createCampaign(baseUrl, adminCookie, 'LIVEREA')
    const reassignedPlayer = await register(baseUrl, 'live-access-reassign@test.invalid', 'Reassigned player')
    await assign(baseUrl, adminCookie, reassignedPlayer.userId, ['hero-1'])
    const reassignAbort = new AbortController()
    streams.push(reassignAbort)
    const reassignStream = await openStream(baseUrl, 'LIVEREA', reassignedPlayer.cookie, reassignAbort.signal)
    const reassignInitial = await nextRoom(reassignStream)
    await assign(baseUrl, adminCookie, reassignedPlayer.userId, ['hero-2'])
    const reassignMe = await request(baseUrl, '/api/auth/me', { cookie: reassignedPlayer.cookie })
    assert.equal(reassignMe.status, 200, reassignMe.text)
    assert.deepEqual(reassignMe.body.user.heroIds, ['hero-2'])
    const freshRoom = await request(baseUrl, '/api/rooms/LIVEREA', { cookie: reassignedPlayer.cookie })
    assert.equal(freshRoom.status, 200, freshRoom.text)
    const freshHeroOne = freshRoom.body.state.players.find((player) => player.id === 'hero-1')
    assert.equal(freshHeroOne.inventory[0].origin, undefined, 'fresh projection сохранила чужое private origin')
    await triggerRoomBroadcast(baseUrl, adminCookie, 'LIVEREA', 'hero-2', 'live-access-reassign-die')
    const reassignRoom = await nextRoom(reassignStream, (payload) => Number(payload.version) > Number(reassignInitial.version))
    const staleHeroOne = reassignRoom.state.players.find((player) => player.id === 'hero-1')
    assert.equal(staleHeroOne.inventory[0].origin, 'stolen', 'старый поток не сохранил исходного actor snapshot')

    console.log(JSON.stringify({
      logout: {
        auth_me_user_after_logout: logoutMe.body.user,
        stale_stream_received_room: Number(logoutRoom.version) > Number(logoutInitial.version),
        stale_stream_online_hero_ids: logoutRoom.state.presence.online_hero_ids,
      },
      expiry: {
        auth_me_user_after_expiry: expiryMe.body.user,
        stale_stream_received_room: Number(expiryRoom.version) > Number(expiryInitial.version),
        stale_stream_online_hero_ids: expiryRoom.state.presence.online_hero_ids,
      },
      hero_reassignment: {
        auth_me_hero_ids_after_reassign: reassignMe.body.user.heroIds,
        fresh_projection_private_origin: freshHeroOne.inventory[0].origin ?? null,
        stale_stream_private_origin: staleHeroOne.inventory[0].origin ?? null,
        stale_stream_online_hero_ids: reassignRoom.state.presence.online_hero_ids,
      },
    }, null, 2))
  } finally {
    for (const controller of streams) controller.abort()
    await stopServer(child)
    if (child && !child.killed && child.exitCode == null) throw new Error('Пробный сервер ещё жив после остановки; временное хранилище оставлено')
    rmSync(storage, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

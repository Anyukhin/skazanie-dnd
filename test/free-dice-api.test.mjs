import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runnerTimeout } from './shared-runner-timeout.mjs'

const SESSION = 'DICE-API'

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: 'free-dice-api-setup',
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
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Тестовый сервер завершился\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* сервер ещё запускается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Тестовый сервер не запустился\n${logs()}`)
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
  try { parsed = text ? JSON.parse(text) : null } catch { /* Проверка выведет исходное тело ответа. */ }
  return { response, status: response.status, body: parsed, text }
}

function sessionCookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0] ?? ''
}

function cells(width = 8, height = 6) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    passable: true,
    revealed: true,
  }))
}

function importedState() {
  return {
    sessionCode: SESSION,
    campaign: 'Две грани',
    partyName: 'Проверка броска',
    partyMemberIds: ['hero-one', 'hero-two'],
    activePlayerId: 'hero-one',
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [
      {
        id: 'hero-one', name: 'Агата', character: 'Агата', role: 'Воин', species: 'Человек',
        level: 1, hp: 20, maxHp: 20, armor: 14, speed: 30, proficiency: 2,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
        inventory: [], online: true, x: 2, y: 2,
      },
      {
        id: 'hero-two', name: 'Гелла', character: 'Гелла', role: 'Плут', species: 'Человек',
        level: 1, hp: 18, maxHp: 18, armor: 13, speed: 30, proficiency: 2,
        abilities: { str: 10, dex: 16, con: 12, int: 12, wis: 10, cha: 10 },
        inventory: [], online: true, x: 4, y: 2,
      },
    ],
    scene: {
      title: 'Зал двух граней', location: 'Зал двух граней', mood: 'Тишина перед броском',
      objective: 'Проверить общий кубик', turn: 0, cells: cells(),
    },
    ruleset_id: 'srd_5_2_1',
    ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'],
    engine_mode: 'enforce',
    state_version: 0,
  }
}

async function openRoomStream(baseUrl, cookie, signal) {
  const response = await fetch(`${baseUrl}/api/campaigns/${SESSION}/stream`, {
    headers: { Cookie: cookie, Accept: 'text/event-stream' },
    signal,
  })
  assert.equal(response.status, 200)
  assert.ok(response.body)
  return { reader: response.body.getReader(), decoder: new TextDecoder(), buffer: '' }
}

async function nextRoomEvent(stream, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    let timer
    const read = await Promise.race([
      stream.reader.read(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE timeout')), remaining) }),
    ]).finally(() => clearTimeout(timer))
    if (read.done) throw new Error('SSE-поток комнаты закрылся')
    stream.buffer += stream.decoder.decode(read.value, { stream: true })
    const blocks = stream.buffer.split(/\r?\n\r?\n/u)
    stream.buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      if (!/^event: room$/mu.test(block)) continue
      const data = block.split(/\r?\n/u)
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n')
      if (!data) continue
      const event = JSON.parse(data)
      if (predicate(event)) return event
    }
  }
  throw new Error('Подходящее SSE-событие комнаты не пришло')
}

test('два владельца получают общий свободный бросок по HTTP и SSE', { timeout: runnerTimeout(45_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-free-dice-'))
  let logs = ''
  let child = null
  const streamAbort = new AbortController()
  let stream = null
  t.after(async () => {
    streamAbort.abort()
    await stream?.reader.cancel().catch(() => {})
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Тестовый мастер', email: 'free-dice-admin@example.test', password: 'FreeDiceAdmin-2026!', setupToken: 'free-dice-api-setup' },
  })
  assert.equal(admin.status, 201, admin.text)
  const adminCookie = sessionCookie(admin)

  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Агата', email: 'free-dice-owner@example.test', password: 'FreeDiceOwner-2026!' },
  })
  const guest = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Гелла', email: 'free-dice-guest@example.test', password: 'FreeDiceGuest-2026!' },
  })
  assert.equal(owner.status, 201, owner.text)
  assert.equal(guest.status, 201, guest.text)
  const ownerCookie = sessionCookie(owner)
  const guestCookie = sessionCookie(guest)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie,
    body: { code: SESSION, name: 'Две грани', state: importedState() },
  })
  assert.equal(created.status, 201, created.text)

  const ownerInvite = await request(baseUrl, `/api/campaigns/${SESSION}/invites`, {
    method: 'POST', cookie: adminCookie, body: { hero_ids: ['hero-one'] },
  })
  const guestInvite = await request(baseUrl, `/api/campaigns/${SESSION}/invites`, {
    method: 'POST', cookie: adminCookie, body: { hero_ids: ['hero-two'] },
  })
  assert.equal(ownerInvite.status, 201, ownerInvite.text)
  assert.equal(guestInvite.status, 201, guestInvite.text)
  const ownerJoined = await request(baseUrl, `/api/campaigns/${SESSION}/join`, {
    method: 'POST', cookie: ownerCookie, body: { invite_token: ownerInvite.body.token },
  })
  const guestJoined = await request(baseUrl, `/api/campaigns/${SESSION}/join`, {
    method: 'POST', cookie: guestCookie, body: { invite_token: guestInvite.body.token },
  })
  assert.equal(ownerJoined.status, 200, ownerJoined.text)
  assert.equal(guestJoined.status, 200, guestJoined.text)
  assert.deepEqual(ownerJoined.body.hero_ids, ['hero-one'])
  assert.deepEqual(guestJoined.body.hero_ids, ['hero-two'])

  const first = await request(baseUrl, `/api/rooms/${SESSION}/dice`, {
    method: 'POST', cookie: ownerCookie, body: { playerId: 'hero-one', sides: 6 },
  })
  assert.equal(first.status, 200, first.text)
  assert.equal(first.body.roll.kind, 'free')
  assert.equal(first.body.roll.sides, 6)
  assert.ok(first.body.roll.value >= 1 && first.body.roll.value <= 6)
  assert.equal(first.body.state.lastDiceRoll.id, first.body.roll.id)

  const guestView = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: guestCookie })
  assert.equal(guestView.status, 200, guestView.text)
  assert.equal(guestView.body.state.lastDiceRoll.id, first.body.roll.id)
  assert.equal(guestView.body.state.lastDiceRoll.value, first.body.roll.value)

  stream = await openRoomStream(baseUrl, guestCookie, streamAbort.signal)
  const second = await request(baseUrl, `/api/rooms/${SESSION}/dice`, {
    method: 'POST', cookie: ownerCookie, body: { playerId: 'hero-one', sides: 20 },
  })
  assert.equal(second.status, 200, second.text)
  const pushed = await nextRoomEvent(stream, (event) => event.state?.lastDiceRoll?.id === second.body.roll.id)
  assert.equal(pushed.state.lastDiceRoll.value, second.body.roll.value)
  assert.equal(pushed.state.lastDiceRoll.sides, 20)

  const guestRoll = await request(baseUrl, `/api/rooms/${SESSION}/dice`, {
    method: 'POST', cookie: guestCookie, body: { playerId: 'hero-two', sides: 4 },
  })
  assert.equal(guestRoll.status, 200, guestRoll.text)
  assert.equal(guestRoll.body.roll.playerId, 'hero-two')
  assert.ok(guestRoll.body.roll.value >= 1 && guestRoll.body.roll.value <= 4)

  const forgedActor = await request(baseUrl, `/api/rooms/${SESSION}/dice`, {
    method: 'POST', cookie: ownerCookie, body: { playerId: 'hero-two', sides: 20 },
  })
  assert.equal(forgedActor.status, 403, forgedActor.text)

  const unsupportedDie = await request(baseUrl, `/api/rooms/${SESSION}/dice`, {
    method: 'POST', cookie: guestCookie, body: { playerId: 'hero-two', sides: 7 },
  })
  assert.equal(unsupportedDie.status, 400, unsupportedDie.text)
})

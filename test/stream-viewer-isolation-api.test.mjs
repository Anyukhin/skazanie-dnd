import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Игра с друзьями по сети держится на одном обещании: каждый видит свой мир.
 * Личное знание героя (`knowledge_ledger`) отделено от общего канона на уровне
 * проекции, но до 2026-07-28 это было проверено только на уровне функции.
 * Живой поток — отдельная поверхность: он отдаёт состояние сам, по своему
 * соединению, и ошибка здесь означала бы, что чужой секрет уезжает игроку в
 * реальном времени, а не по запросу.
 *
 * Тест поднимает настоящий сервер, подключает двух игроков к SSE, раскрывает
 * факт **одному** и сверяет оба потока.
 */

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const { port } = probe.address()
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'isolation-setup', GAME_ENGINE_MODE: 'enforce',
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
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Server did not become healthy\n${logs()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body, key = '' } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(key ? { 'X-Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text }
}

const sessionCookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

async function openRoomStream(baseUrl, campaignId, cookie, signal) {
  const response = await fetch(`${baseUrl}/api/campaigns/${campaignId}/stream`, {
    headers: { Cookie: cookie, Accept: 'text/event-stream' }, signal,
  })
  assert.equal(response.status, 200)
  return { reader: response.body.getReader(), decoder: new TextDecoder(), buffer: '', queued: [] }
}

async function nextRoomEvent(stream, predicate = () => true) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    while (stream.queued.length) {
      const value = stream.queued.shift()
      if (predicate(value)) return value
    }
    const remaining = Math.max(1, deadline - Date.now())
    let timeout
    const read = await Promise.race([
      stream.reader.read(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('SSE timeout')), remaining) }),
    ]).finally(() => clearTimeout(timeout))
    if (read.done) throw new Error('SSE stream closed')
    stream.buffer += stream.decoder.decode(read.value, { stream: true })
    const blocks = stream.buffer.split(/\r?\n\r?\n/u)
    stream.buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      if (!/^event: room$/mu.test(block)) continue
      const data = block.split(/\r?\n/u).filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
      if (data) stream.queued.push(JSON.parse(data))
    }
  }
  throw new Error('No matching room event')
}

function hero(id, name) {
  return {
    id, name, character: name, characterClass: 'fighter', level: 1, experience: 0,
    hp: 12, maxHp: 12, armor: 10, speed: 30,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    inventory: [],
  }
}

const SECRET = 'ТАЙНА-ТОЛЬКО-ДЛЯ-ПЕРВОГО-ГЕРОЯ'

test('живой поток отдаёт каждому игроку только его знание', { timeout: runnerTimeout(90_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-stream-isolation-'))
  let logs = ''
  let child = null
  const ownerAbort = new AbortController()
  const guestAbort = new AbortController()
  t.after(async () => {
    ownerAbort.abort()
    guestAbort.abort()
    if (child && child.exitCode == null) await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
    rmSync(storage, { recursive: true, force: true })
  })

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  // Владелец — администратор: мировая память правится только административным
  // контуром, а игроку доступен лишь безопасный боевой набор команд.
  const owner = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Owner', email: 'isolation-owner@test.local', password: 'secure-owner-password', setupToken: 'isolation-setup' },
  })
  assert.equal(owner.status, 201, owner.text)
  // Два обычных игрока: именно между ними обязана пройти граница знания.
  // Администратор здесь только ведёт мир и в сравнении потоков не участвует.
  const first = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: { name: 'First', email: 'isolation-first@test.local', password: 'secure-first-password' },
  })
  const second = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: { name: 'Second', email: 'isolation-second@test.local', password: 'secure-second-password' },
  })
  const ownerCookie = sessionCookie(owner)
  const firstCookie = sessionCookie(first)
  const secondCookie = sessionCookie(second)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: ownerCookie,
    body: {
      code: 'ISOLAT', name: 'Изоляция знания',
      bootstrap: { partyName: 'Двое', players: [hero('hero-1', 'Первый'), hero('hero-2', 'Второй')] },
    },
  })
  assert.equal(created.status, 201, created.text)

  for (const [heroId, cookie] of [['hero-1', firstCookie], ['hero-2', secondCookie]]) {
    const invite = await request(baseUrl, '/api/campaigns/ISOLAT/invites', {
      method: 'POST', cookie: ownerCookie, body: { hero_ids: [heroId] },
    })
    assert.equal(invite.status, 201, invite.text)
    assert.equal((await request(baseUrl, '/api/campaigns/ISOLAT/join', {
      method: 'POST', cookie, body: { invite_token: invite.body.token },
    })).status, 200)
  }

  const ownerStream = await openRoomStream(baseUrl, 'ISOLAT', firstCookie, ownerAbort.signal)
  const guestStream = await openRoomStream(baseUrl, 'ISOLAT', secondCookie, guestAbort.signal)
  await nextRoomEvent(ownerStream, (event) => event.state.presence.online_hero_ids.length === 2)
  await nextRoomEvent(guestStream, (event) => event.state.presence.online_hero_ids.length === 2)

  // Владелец кампании заводит сущность, скрытый факт о ней и открывает факт
  // только первому герою. Всё — типизированными командами, через движок.
  const admin = (key, command) => request(baseUrl, '/api/campaigns/ISOLAT/commands', {
    method: 'POST', cookie: ownerCookie, key, body: { idempotency_key: key, command },
  })
  const entity = await admin('isolation-entity', {
    command_type: 'UpsertWorldEntity', actor_id: 'hero-1',
    entity: { id: 'location:vault', kind: 'location', name: 'Тайник', summary: 'Запертая комната.', visibility: 'party' },
  })
  assert.equal(entity.status, 200, entity.text)
  const fact = await admin('isolation-fact', {
    command_type: 'RecordWorldFact', actor_id: 'hero-1',
    fact: {
      id: 'fact:vault-secret', subject_id: 'location:vault', predicate: 'hides',
      object: SECRET, summary: SECRET, visibility: 'gm_only', source_event_ids: ['event:isolation'],
    },
  })
  assert.equal(fact.status, 200, fact.text)
  const revealed = await admin('isolation-reveal', {
    command_type: 'RevealWorldFact', actor_id: 'hero-1', fact_id: 'fact:vault-secret', target_ids: ['hero-1'],
  })
  assert.equal(revealed.status, 200, revealed.text)

  // Оба потока обязаны довезти обновление — канал живой для всех. Ждать надо
  // именно состояние **после раскрытия**: сущность и сам факт приезжают более
  // ранними коммитами, и сравнение на них поймало бы устаревший снимок.
  const ownerView = await nextRoomEvent(
    ownerStream,
    (event) => (event.state.worldMemory?.knowledge_ledger ?? []).some((entry) => entry.fact_id === 'fact:vault-secret'),
  )
  const guestView = await nextRoomEvent(
    guestStream,
    (event) => Number(event.state.state_version) >= Number(ownerView.state.state_version),
  )

  const ownerPayload = JSON.stringify(ownerView.state)
  const guestPayload = JSON.stringify(guestView.state)

  assert.ok(
    ownerPayload.includes(SECRET),
    `герой, которому факт раскрыт, обязан его видеть; фактов в проекции: ${(ownerView.state.worldMemory?.facts ?? []).length}`,
  )
  assert.equal(
    guestPayload.includes(SECRET),
    false,
    'чужой личный секрет уехал второму игроку живым потоком',
  )

  // Общая часть мира при этом одинакова: изоляция режет знание, а не сцену.
  assert.equal(ownerView.state.scene?.location, guestView.state.scene?.location)
  assert.deepEqual(
    ownerView.state.presence.online_hero_ids,
    guestView.state.presence.online_hero_ids,
  )

  // И обычный опрос обязан давать ту же границу, что и поток: иначе игрок
  // увидел бы чужой секрет, просто обновив страницу.
  const guestPoll = await request(baseUrl, '/api/rooms/ISOLAT', { cookie: secondCookie })
  assert.equal(guestPoll.status, 200, guestPoll.text)
  assert.equal(guestPoll.text.includes(SECRET), false, 'опрос отдал чужой секрет в обход проекции')
  const ownerPoll = await request(baseUrl, '/api/rooms/ISOLAT', { cookie: firstCookie })
  assert.ok(ownerPoll.text.includes(SECRET), 'владельцу знания опрос обязан вернуть факт')
})

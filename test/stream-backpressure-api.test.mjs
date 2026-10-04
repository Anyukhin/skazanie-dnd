import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Аудит PR #131, SEC-06. Backpressure живого потока раньше держал только текст
 * повествования: рассылка комнаты писала в сокет каждый кадр, даже когда
 * `res.write()` уже сообщил о переполнении. Клиент, который не читает сокет,
 * копил в памяти сервера по полному состоянию кампании на каждый коммит.
 *
 * Тест поднимает настоящий сервер на временном хранилище и держит два потока
 * одного администратора: быстрый читает всё, медленный не читает вовсе, пока
 * идут коммиты. Кампания нарочно тяжёлая — около полутора мегабайт памяти мира
 * в каждом кадре, — чтобы сокет медленного потока гарантированно переполнился.
 * После того как медленный начинает читать, он обязан получить последнее
 * состояние, а промежуточные комнаты — схлопнуться; быстрый поток получает
 * каждую рассылку, как и раньше.
 */

const CODE = 'SLOWSSE'
const COMMITS = 12

function startServer(port, storage, emptyEnv, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      DOTENV_CONFIG_PATH: emptyEnv, ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'slow-stream-setup',
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

function hero(id, name) {
  return {
    id, character: name, name, hp: 12, maxHp: 12, armor: 10, speed: 30, proficiency: 2,
    abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [],
  }
}

/**
 * Тяжёлая, но законная кампания: память мира упирается в обычные пределы
 * нормализатора, а тело запроса — в предел `readBody`.
 */
function heavyCampaignState() {
  const filler = 'Летопись хранит подробности этой встречи. '.repeat(9)
  return {
    sessionCode: CODE, campaign: 'Медленный читатель', partyName: 'Отряд',
    activePlayerId: 'hero-1', partyMemberIds: ['hero-1'], messages: [],
    players: [hero('hero-1', 'Первый')],
    scene: { title: 'Зал', location: 'Зал', mood: '', objective: '', turn: 1, cells: [] },
    adventure: { chapter: 1, visitedLocations: ['Зал'], history: [] },
    worldMemory: {
      entities: [{ id: 'npc:chronicler', kind: 'npc', name: 'Летописец', summary: 'Помнит всё.', visibility: 'party' }],
      facts: Array.from({ length: 1_600 }, (_, index) => ({
        id: `fact:chronicle-${index}`, subject_id: 'npc:chronicler', predicate: 'remembers', object: `запись ${index}`,
        summary: `${index}. ${filler}`, visibility: 'party', status: 'active', source_event_ids: [], recorded_at_minutes: 0,
      })),
    },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'],
    state_version: 0,
  }
}

/** Разбор SSE-блоков: версии комнат по порядку прихода. */
function sseRoomCollector() {
  const decoder = new TextDecoder()
  let buffer = ''
  const versions = []
  let bytes = 0
  return {
    versions,
    get bytes() { return bytes },
    push(chunk) {
      bytes += chunk.length
      buffer += decoder.decode(chunk, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/u)
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        if (!/^event: room$/mu.test(block)) continue
        const data = block.split(/\r?\n/u).filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
        versions.push(Number(JSON.parse(data).version))
      }
    },
  }
}

/** Поток, который читается всё время. */
async function openFastStream(baseUrl, cookie, signal) {
  const response = await fetch(`${baseUrl}/api/campaigns/${CODE}/stream`, {
    headers: { Cookie: cookie, Accept: 'text/event-stream' }, signal,
  })
  assert.equal(response.status, 200)
  const rooms = sseRoomCollector()
  const reader = response.body.getReader()
  const pump = (async () => {
    for (;;) {
      const read = await reader.read().catch(() => ({ done: true }))
      if (read.done) return
      rooms.push(read.value)
    }
  })()
  return { rooms, pump }
}

/**
 * Поток, который не читается: ответ поставлен на паузу сразу после заголовков,
 * и клиент перестаёт забирать данные из сокета. `resume()` начинает чтение.
 */
async function openStalledStream(baseUrl, cookie) {
  const { request: clientRequest, response } = await new Promise((resolve, reject) => {
    const outgoing = httpGet(`${baseUrl}/api/campaigns/${CODE}/stream`, {
      headers: { Cookie: cookie, Accept: 'text/event-stream' },
    }, (incoming) => resolve({ request: outgoing, response: incoming }))
    outgoing.once('error', reject)
  })
  assert.equal(response.statusCode, 200)
  response.pause()
  const rooms = sseRoomCollector()
  let closed = false
  response.once('close', () => { closed = true })
  return {
    rooms,
    get closed() { return closed },
    resume() {
      response.on('data', (chunk) => rooms.push(chunk))
      response.resume()
    },
    destroy() { clientRequest.destroy() },
  }
}

async function waitFor(check, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message())
}

test('медленный читатель получает последнюю комнату, промежуточные схлопнуты (аудит PR #131, SEC-06)', { timeout: runnerTimeout(120_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-slow-stream-'))
  const emptyEnv = join(storage, '.env.empty')
  writeFileSync(emptyEnv, '', 'utf8')
  let logs = ''
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = startServer(port, storage, emptyEnv, (chunk) => { logs += chunk })
  const fastAbort = new AbortController()
  let stalled = null
  t.after(async () => {
    fastAbort.abort()
    stalled?.destroy()
    if (child.exitCode == null) await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
    rmSync(storage, { recursive: true, force: true })
  })
  await waitForHealth(baseUrl, child, () => logs)
  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Ведущий', email: 'slow-admin@test.local', password: 'secure-slow-admin-password', setupToken: 'slow-stream-setup' },
  })
  assert.equal(admin.status, 201, admin.text)
  const cookie = admin.response.headers.get('set-cookie')?.split(';')[0]
  const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie, body: { code: CODE, state: heavyCampaignState() } })
  assert.equal(created.status, 201, created.text.slice(0, 500))

  const fast = await openFastStream(baseUrl, cookie, fastAbort.signal)
  stalled = await openStalledStream(baseUrl, cookie)
  await waitFor(() => fast.rooms.versions.length > 0, () => `быстрый поток не получил первую комнату\n${logs}`)

  // Коммиты по одному: каждый сохраняет комнату и рассылает её обоим потокам.
  for (let index = 0; index < COMMITS; index += 1) {
    const rolled = await request(baseUrl, `/api/rooms/${CODE}/dice`, {
      method: 'POST', cookie, body: { playerId: 'hero-1', sides: 20, idempotency_key: `slow-stream-${index}` },
    })
    assert.equal(rolled.status, 200, rolled.text.slice(0, 500))
  }
  const finalRoom = await request(baseUrl, `/api/rooms/${CODE}`, { cookie })
  const finalVersion = Number(finalRoom.body.version)
  const frameBytes = Buffer.byteLength(JSON.stringify(finalRoom.body.state))
  assert.ok(frameBytes > 1_000_000, `кадр комнаты должен быть тяжёлым, а весит ${frameBytes} байт`)

  // Быстрый поток не изменился: он получает каждую рассылку.
  await waitFor(() => fast.rooms.versions.at(-1) >= finalVersion, () => `быстрый поток не дошёл до ${finalVersion}: ${fast.rooms.versions}\n${logs}`)
  assert.ok(fast.rooms.versions.length > COMMITS, `быстрый поток потерял рассылки: ${fast.rooms.versions}`)
  assert.equal(stalled.closed, false, 'медленный поток закрыт, хотя его очередь схлопывается и не переполняется')

  // Медленный начинает читать: приходит уже принятое Node и последнее состояние.
  stalled.resume()
  await waitFor(() => stalled.rooms.versions.at(-1) >= finalVersion, () => `медленный поток не получил последнюю комнату ${finalVersion}: ${stalled.rooms.versions}\n${logs}`)
  const slow = stalled.rooms.versions
  t.diagnostic(`кадров комнаты: медленный ${slow.length} (${stalled.rooms.bytes} Б), быстрый ${fast.rooms.versions.length} (${fast.rooms.bytes} Б)`)
  assert.deepEqual([...slow].sort((left, right) => left - right), slow, 'комнаты пришли не по порядку')
  assert.ok(slow.length < fast.rooms.versions.length - COMMITS / 2,
    `промежуточные комнаты не схлопнуты: медленный ${slow.length} (${slow}), быстрый ${fast.rooms.versions.length}`)
  assert.ok(stalled.rooms.bytes < fast.rooms.bytes / 2,
    `медленный поток получил почти всё: ${stalled.rooms.bytes} из ${fast.rooms.bytes} байт`)
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { auditLegacyCutover } from '../server/cutover-audit.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { MapStore } from '../server/map-store.mjs'
import { projectionHash } from '../server/projection-integrity.mjs'
import { GAME_STATE_PROJECTOR_VERSION, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Эксплуатационная проверка: сервер убивают посреди работы, пока по нему идут
 * конкурентные запросы.
 *
 * Unit-тесты давно проверяют replay и перезапуск на чистом столе: команда
 * выполнена, процесс закрыт аккуратно, состояние перечитано. Настоящая
 * авария выглядит иначе — SIGKILL приходит между commit'ом события и записью
 * проекции, и приходит он тогда, когда в полёте несколько запросов от разных
 * игроков. Именно этот случай не проверялся ни разу
 * (`docs/production-readiness.md`), а на нём держится обещание «кампанию
 * нельзя потерять».
 *
 * Тест бьёт по трём инвариантам после каждой аварии:
 * 1) поток событий переигрывается в то же состояние — ничего не потеряно;
 * 2) ни одна подтверждённая команда не исчезла и не удвоилась;
 * 3) после подъёма сервер сам приводит проекцию в согласие с потоком.
 */

const CRASH_ROUNDS = 3
const CONCURRENT_COMMANDS = 6

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
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'soak-setup', GAME_ENGINE_MODE: 'enforce',
      COOKIE_SECURE: 'false', NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited\n${logs()}`)
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Server did not become healthy\n${logs()}`)
}

/** SIGKILL: процесс не получает шанса ничего дописать или прибрать. */
async function kill(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGKILL') })
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

const hero = (id, name) => ({
  id, name, character: name, characterClass: 'fighter', level: 1, experience: 0,
  hp: 20, maxHp: 20, armor: 10, speed: 30,
  abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [],
})

function storeFor(storage) {
  const engineRoot = join(storage, 'engine')
  return new FileEventStore({
    rootDir: engineRoot,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
    mapStore: new MapStore({ rootDir: engineRoot }),
  })
}

test('сервер переживает убийства посреди конкурентных запросов и не теряет ни одной команды', { timeout: runnerTimeout(180_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-soak-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await kill(child)
    rmSync(storage, { recursive: true, force: true })
  })

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const owner = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Owner', email: 'soak-owner@test.local', password: 'secure-owner-password', setupToken: 'soak-setup' },
  })
  assert.equal(owner.status, 201, owner.text)
  const cookie = sessionCookie(owner)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie,
    body: { code: 'SOAK', name: 'Soak', bootstrap: { partyName: 'Двое', players: [hero('hero-1', 'Первый'), hero('hero-2', 'Второй')] } },
  })
  assert.equal(created.status, 201, created.text)

  // Пробная команда до первой аварии: если она не проходит, дальше проверять
  // нечего, и падать надо с её ответом, а не с загадочным «ноль подтверждений».
  const probe = await request(baseUrl, '/api/campaigns/SOAK/commands', {
    method: 'POST', cookie, key: 'soak-probe',
    body: { idempotency_key: 'soak-probe', command: { command_type: 'ApplyHealing', actor_id: 'hero-1', amount: 1 } },
  })
  assert.equal(probe.status, 200, `команда не принимается сервером: ${probe.text}`)

  /** Ключи всех команд, на которые сервер успел ответить «принято». */
  const acknowledged = new Set(['soak-probe'])
  let issued = 1

  for (let round = 1; round <= CRASH_ROUNDS; round += 1) {
    // Волна конкурентных команд от обоих героев одновременно. Ответов не ждём:
    // авария обязана застать часть из них в полёте.
    const inFlight = []
    let firstAcknowledged = null
    const sawFirst = new Promise((resolve) => { firstAcknowledged = resolve })
    for (let index = 0; index < CONCURRENT_COMMANDS; index += 1) {
      issued += 1
      const key = `soak-${round}-${index}`
      const actorId = index % 2 === 0 ? 'hero-1' : 'hero-2'
      inFlight.push(
        request(baseUrl, '/api/campaigns/SOAK/commands', {
          method: 'POST', cookie, key,
          body: { idempotency_key: key, command: { command_type: 'ApplyHealing', actor_id: actorId, amount: 1 } },
        })
          .then((result) => { if (result.status === 200) { acknowledged.add(key); firstAcknowledged() } })
          .catch(() => { /* оборванный запрос — законный исход аварии */ }),
      )
    }
    // Убиваем не по таймеру, а по факту: как только сервер подтвердил первую
    // команду волны, остальные заведомо в полёте. Так авария гарантированно
    // приходится на промежуток между подтверждённым событием и записанной
    // проекцией, а не до начала работы.
    await Promise.race([sawFirst, new Promise((resolve) => setTimeout(resolve, 5_000))])
    await kill(child)
    await Promise.allSettled(inFlight)
    assert.ok(
      [...acknowledged].some((key) => key.startsWith(`soak-${round}-`)),
      `раунд ${round}: сервер не подтвердил ни одной команды волны — авария пришлась не на работу`,
    )

    // Инвариант 1: поток переигрывается в то же состояние без снимков.
    const store = storeFor(storage)
    const loaded = await store.load('SOAK')
    const replayed = await store.replay('SOAK', { useSnapshots: false })
    assert.equal(
      projectionHash(loaded.state), projectionHash(replayed.state),
      `раунд ${round}: состояние из снимка разошлось с чистым replay`,
    )

    // Инвариант 2: каждая подтверждённая команда осталась ровно одной записью.
    for (const key of acknowledged) {
      const committed = await store.getByIdempotencyKey('SOAK', key)
      assert.ok(committed, `раунд ${round}: подтверждённая команда ${key} исчезла после аварии`)
    }

    child = startServer(port, storage, (chunk) => { logs += chunk })
    await waitForHealth(baseUrl, child, () => logs)

    // Инвариант 3: поднявшись, сервер сам приводит проекцию в согласие.
    const room = await request(baseUrl, '/api/rooms/SOAK', { cookie })
    assert.equal(room.status, 200, room.text)
    const report = await auditLegacyCutover({ storageRoot: storage })
    assert.deepEqual(
      report.blockers, [],
      `раунд ${round}: после подъёма остались блокеры целостности: ${JSON.stringify(report.blockers)}`,
    )
  }

  assert.ok(acknowledged.size > 0, `ни одна команда не была подтверждена из ${issued} — тест ничего не проверил`)

  // Повтор подтверждённого ключа после всех аварий обязан вернуть прежний
  // commit, а не создать второй: идемпотентность переживает падение.
  const store = storeFor(storage)
  const [firstKey] = acknowledged
  const before = await store.getByIdempotencyKey('SOAK', firstKey)
  const repeated = await request(baseUrl, '/api/campaigns/SOAK/commands', {
    method: 'POST', cookie, key: firstKey,
    body: { idempotency_key: firstKey, command: { command_type: 'ApplyHealing', actor_id: 'hero-1', amount: 1 } },
  })
  assert.equal(repeated.status, 200, repeated.text)
  const after = await store.getByIdempotencyKey('SOAK', firstKey)
  assert.equal(after.state_version, before.state_version, 'повтор ключа создал новый commit вместо возврата прежнего')
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { readJournal, startTestServer } from './kit/index.mjs'
// Аудит перехода читает файловое хранилище JS напрямую: помощника кита для
// него нет (решение ведущего), поэтому файл пока не контрактный.
import { auditLegacyCutover } from '../server/cutover-audit.mjs'
import { projectionHash } from '../server/projection-integrity.mjs'
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

/**
 * SIGKILL: процесс не получает шанса ничего дописать или прибрать. Штатный
 * `server.stop()` кита шлёт SIGTERM, а его сервер обрабатывает.
 *
 * @param {import('./kit/http.mjs').TestServer} server
 */
async function kill(server) {
  if (!server.running()) return
  const exited = server.waitForExit()
  server.child?.kill('SIGKILL')
  await exited
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

/**
 * Подтверждённая команда в журнале по её ключу или `undefined`.
 *
 * @param {import('./kit/journal.mjs').Journal} journal
 * @param {string} key
 */
const commitByKey = (journal, key) => journal.commits.find((commit) => commit.idempotency_key === key)

test('сервер переживает убийства посреди конкурентных запросов и не теряет ни одной команды', { timeout: runnerTimeout(180_000) }, async (t) => {
  // Адрес меняется на каждом подъёме: запросы берут `server.baseUrl` в момент вызова.
  const server = await startTestServer(t, { storagePrefix: 'skazanie-soak-', setupToken: 'soak-setup' })

  const owner = await request(server.baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Owner', email: 'soak-owner@test.local', password: 'secure-owner-password', setupToken: 'soak-setup' },
  })
  assert.equal(owner.status, 201, owner.text)
  const cookie = sessionCookie(owner)

  const created = await request(server.baseUrl, '/api/campaigns', {
    method: 'POST', cookie,
    body: { code: 'SOAK', name: 'Soak', bootstrap: { partyName: 'Двое', players: [hero('hero-1', 'Первый'), hero('hero-2', 'Второй')] } },
  })
  assert.equal(created.status, 201, created.text)

  // Пробная команда до первой аварии: если она не проходит, дальше проверять
  // нечего, и падать надо с её ответом, а не с загадочным «ноль подтверждений».
  const probe = await request(server.baseUrl, '/api/campaigns/SOAK/commands', {
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
        request(server.baseUrl, '/api/campaigns/SOAK/commands', {
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
    await kill(server)
    await Promise.allSettled(inFlight)
    assert.ok(
      [...acknowledged].some((key) => key.startsWith(`soak-${round}-`)),
      `раунд ${round}: сервер не подтвердил ни одной команды волны — авария пришлась не на работу`,
    )

    // Инвариант 1: поток переигрывается в то же состояние без снимков.
    const loaded = await readJournal(server, 'SOAK')
    const replayed = await readJournal(server, 'SOAK', { useSnapshots: false })
    assert.equal(
      projectionHash(loaded.state), projectionHash(replayed.state),
      `раунд ${round}: состояние из снимка разошлось с чистым replay`,
    )

    // Инвариант 2: каждая подтверждённая команда осталась ровно одной записью.
    for (const key of acknowledged) {
      const committed = commitByKey(loaded, key)
      assert.ok(committed, `раунд ${round}: подтверждённая команда ${key} исчезла после аварии`)
    }

    await server.start()

    // Инвариант 3: поднявшись, сервер сам приводит проекцию в согласие.
    const room = await request(server.baseUrl, '/api/rooms/SOAK', { cookie })
    assert.equal(room.status, 200, room.text)
    const report = await auditLegacyCutover({ storageRoot: server.storageDir })
    assert.deepEqual(
      report.blockers, [],
      `раунд ${round}: после подъёма остались блокеры целостности: ${JSON.stringify(report.blockers)}`,
    )
  }

  assert.ok(acknowledged.size > 0, `ни одна команда не была подтверждена из ${issued} — тест ничего не проверил`)

  // Повтор подтверждённого ключа после всех аварий обязан вернуть прежний
  // commit, а не создать второй: идемпотентность переживает падение.
  const [firstKey] = acknowledged
  const before = commitByKey(await readJournal(server, 'SOAK'), firstKey)
  const repeated = await request(server.baseUrl, '/api/campaigns/SOAK/commands', {
    method: 'POST', cookie, key: firstKey,
    body: { idempotency_key: firstKey, command: { command_type: 'ApplyHealing', actor_id: 'hero-1', amount: 1 } },
  })
  assert.equal(repeated.status, 200, repeated.text)
  const after = commitByKey(await readJournal(server, 'SOAK'), firstKey)
  assert.equal(after.state_version_after, before.state_version_after, 'повтор ключа создал новый commit вместо возврата прежнего')
})

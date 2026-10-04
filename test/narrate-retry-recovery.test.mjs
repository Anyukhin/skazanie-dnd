import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  clearPendingNarrate,
  isTacticalCommandUnknown,
  narrateRecoveryFor,
  pendingNarrateStorageKey,
  readPendingNarrate,
  writePendingNarrate,
} from '../src/tactical-command-recovery.mjs'

/**
 * Аудит PR #131, REC-01: обычный ход `/api/narrate` с автоброском записан
 * сервером, ответ потерян, а повтор той же фразы уходил с новым
 * idempotency_key — вторая проверка и второй бросок (проба
 * docs/reviews/2026-10-04/round-4/22-narrate-retry.md).
 *
 * Здесь — настоящий клиентский модуль `src/ai-client.ts`, собранный тем же
 * способом, что в пробе аудита и в test/state-version-conflict-ux.test.mjs, и
 * поддельный сервер с идемпотентностью по ключу. React-хук в Node не
 * монтируется, поэтому порядок шагов `submitAction` сверяется по исходнику.
 *
 * Серверная половина гарантии уже под сторожем: тот же ключ возвращает
 * прежний commit — test/free-action.test.mjs («повтор свободного действия с
 * тем же idempotency_key…»: свободная проверка с автоброском, AbilityCheckResolved
 * в одном запросе), test/nonstandard-action-api.test.mjs (HTTP, вторая фаза с
 * roll_id и повтор после рестарта), test/narration-stream-api.test.mjs (HTTP,
 * параллельный дубль).
 */

const sessionSource = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')

const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-narrate-retry-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const clientPath = fileURLToPath(new URL('../src/ai-client.ts', import.meta.url))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, clientPath,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
const compiledPath = join(buildDir, 'ai-client.mjs')
renameSync(join(buildDir, 'ai-client.js'), compiledPath)
const client = await import(pathToFileURL(compiledPath).href)

test.after(() => rmSync(buildDir, { recursive: true, force: true }))

function memoryStorage() {
  const map = new Map()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  }
}

/** Поддельный `/api/narrate`: новый ключ — новый commit, прежний — replay. */
function installNarrateServer(lose) {
  const commits = new Map()
  const bodies = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init.body))
    bodies.push(body)
    const replay = commits.has(body.idempotency_key)
    if (!replay) commits.set(body.idempotency_key, `roll-${commits.size + 1}`)
    if (bodies.length === 1) return lose()
    return new Response(JSON.stringify({
      narration: 'Проверка силы уже решена.',
      effects: {},
      mechanics: [{ event_type: 'AbilityCheckResolved', payload: { roll_id: commits.get(body.idempotency_key) } }],
      idempotent_replay: replay,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return { commits, bodies, restore: () => { globalThis.fetch = originalFetch } }
}

const state = { sessionCode: 'RETRY-1' }
const intent = { campaignId: 'RETRY-1', actorId: 'hero-a', action: 'Проверяю силу', requestKind: 'action' }

/** Шаги `submitAction`: запись до отправки, снятие только известным исходом. */
async function submit(storage, key, manualRoll = false) {
  let recovery = null
  try {
    recovery = narrateRecoveryFor(readPendingNarrate(storage, key), intent, { newKey: client.newIdempotencyKey, manualRoll })
    writePendingNarrate(storage, key, recovery)
    const result = await client.narrateWithAgent(state, intent.action, 'Герой', undefined, recovery.requestId, intent.actorId, {
      requestKind: intent.requestKind, manualRoll: recovery.manualRoll,
    })
    clearPendingNarrate(storage, key, recovery.requestId)
    return { ok: true, result }
  } catch (error) {
    if (recovery && !isTacticalCommandUnknown(error)) clearPendingNarrate(storage, key, recovery.requestId)
    return { ok: false, error }
  }
}

test('потеря ответа после commit: повтор той же фразы уходит с прежним ключом и не пишет второй ход', async () => {
  for (const [label, lose] of [
    ['обрыв соединения', () => { throw new TypeError('fetch failed') }],
    ['503 без тела', () => new Response('', { status: 503 })],
    ['503 прокси', () => new Response(JSON.stringify({ code: 'PROXY_DROP_AFTER_COMMIT' }), { status: 503 })],
    ['обрезанный JSON', () => new Response('{"narration":', { status: 200 })],
    // Аудит PR #131, UI-08/REC-03: неполный, но разборчивый ответ — тоже
    // неизвестный исход, а не успех, который потом роняет `finishTurn`.
    ['неполный ответ 200', () => new Response('{}', { status: 200 })],
    ['ответ 200 без effects', () => new Response(JSON.stringify({ narration: 'Готово.' }), { status: 200 })],
  ]) {
    const storage = memoryStorage()
    const key = pendingNarrateStorageKey('account-a', state.sessionCode)
    const server = installNarrateServer(lose)
    try {
      const first = await submit(storage, key)
      assert.equal(first.ok, false, label)
      assert.equal(isTacticalCommandUnknown(first.error), true, label)
      assert.ok(readPendingNarrate(storage, key), `${label}: запись пережила неизвестный исход`)

      const retry = await submit(storage, key)
      assert.equal(retry.ok, true, label)
      assert.equal(server.bodies.length, 2)
      assert.equal(server.bodies[1].idempotency_key, server.bodies[0].idempotency_key, label)
      assert.deepEqual(server.bodies[1], server.bodies[0], `${label}: повтор отправляет то же тело`)
      assert.equal(retry.result.idempotent_replay, true, label)
      assert.equal(server.commits.size, 1, `${label}: второй проверки нет`)
      assert.equal(readPendingNarrate(storage, key), null, `${label}: ответ снимает запись`)
    } finally {
      server.restore()
    }
  }
})

test('авторитетный отказ 4xx снимает запись: следующая такая же фраза — новый ключ', async () => {
  const storage = memoryStorage()
  const key = pendingNarrateStorageKey('account-a', state.sessionCode)
  const server = installNarrateServer(() => new Response(JSON.stringify({ error: 'Слишком много ходов' }), { status: 429 }))
  try {
    const first = await submit(storage, key)
    assert.equal(first.ok, false)
    assert.equal(first.error.status, 429)
    assert.equal(readPendingNarrate(storage, key), null)
    await submit(storage, key)
    assert.notEqual(server.bodies[1].idempotency_key, server.bodies[0].idempotency_key)
  } finally {
    server.restore()
  }
})

test('UI-08/REC-03: декодер хода пропускает исправные ответы тем же объектом и отклоняет неполные без HTTP-статуса', () => {
  const { decodeTurnResult, MalformedTurnResultError } = client
  const valid = [
    ['обычный ход', { narration: 'Дверь поддаётся.', effects: { roll: null, reveal: [], spawn: [], objective: null, grantItems: [] }, mechanics: [] }],
    ['ход без кости в проекции', { narration: '', effects: {} }],
    ['ход с состоянием', { narration: 'Ок.', effects: {}, authoritative_state: { players: [] }, mechanics: [{ event_type: 'ActorMoved' }] }],
    ['карточка проверки без effects', { narration: 'Требуется проверка', check: { label: 'Сила', modifier: 2, difficulty: 12, sides: 20 } }],
    ['манёвр без effects', { narration: 'Проверьте маршрут', action_proposal: { id: 'proposal-1' } }],
    ['уточнение', { narration: 'Что именно?', effects: {}, clarification: { id: 'c-1' }, check: null }],
  ]
  for (const [label, value] of valid) assert.equal(decodeTurnResult(value), value, label)

  const malformed = [
    ['пустой объект', {}],
    ['null', null],
    ['массив', []],
    ['строка', 'ok'],
    ['нет effects у завершённого хода', { narration: 'Готово.' }],
    ['нет текста у завершённого хода', { effects: {} }],
    ['текст не строка', { narration: 42, effects: {} }],
    ['effects не объект', { narration: '', effects: [] }],
    ['grantItems не массив', { narration: '', effects: { grantItems: {} } }],
    ['пустая выдача в grantItems', { narration: '', effects: { grantItems: [null] } }],
    ['roll не объект', { narration: '', effects: { roll: 'd20' } }],
    ['mechanics не массив', { narration: '', effects: {}, mechanics: {} }],
    ['состояние без героев', { narration: '', effects: {}, authoritative_state: {} }],
    ['карточка не объект', { narration: '', check: 'Сила' }],
  ]
  for (const [label, value] of malformed) {
    assert.throws(() => decodeTurnResult(value), (error) => {
      assert.ok(error instanceof MalformedTurnResultError, label)
      assert.equal(error.status, undefined, `${label}: у отказа нет HTTP-статуса`)
      assert.equal(isTacticalCommandUnknown(error), true, `${label}: исход неизвестен, запись REC-01 остаётся`)
      return true
    }, label)
  }
})

test('narrateWithAgent отправляет переданный ключ и записанный режим броска', async () => {
  const bodies = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ narration: '', effects: {} }), { status: 200 })
  }
  try {
    await client.narrateWithAgent(state, 'Проверяю силу', 'Герой', undefined, 'stored-key', 'hero-a', { manualRoll: false })
    await client.narrateWithAgent(state, 'Проверяю силу', 'Герой', undefined, 'stored-key', 'hero-a', { manualRoll: true })
    // Без записанного режима — прежнее поведение: настройка автоброска, в Node её нет.
    await client.narrateWithAgent(state, 'Проверяю силу', 'Герой', undefined, 'stored-key', 'hero-a')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(bodies.map((body) => body.idempotency_key), ['stored-key', 'stored-key', 'stored-key'])
  assert.deepEqual(bodies.map((body) => body.manual_roll), [undefined, true, true])
})

test('submitAction ставит запись до отправки, повторяет её ключ и хранит её при неизвестном исходе', () => {
  const start = sessionSource.indexOf('const submitAction = useCallback(')
  const end = sessionSource.indexOf('const confirmPendingAction = useCallback(')
  assert.ok(start >= 0 && end > start, 'submitAction не найден')
  const submitAction = sessionSource.slice(start, end)

  const read = submitAction.indexOf('narrateRecoveryFor(readPendingNarrate(narrateStorage, narrateStorageKey), intent')
  const write = submitAction.indexOf('writePendingNarrate(narrateStorage, narrateStorageKey, narrateRecovery)')
  const send = submitAction.indexOf('await narrateWithAgent(')
  assert.ok(read >= 0, 'запись берётся из sessionStorage под аккаунтом и кампанией')
  assert.ok(write > read && send > write, 'запись ставится до отправки')
  assert.match(submitAction, /pendingNarrateStorageKey\(accountId, state\.sessionCode\)/u)
  assert.match(submitAction, /narrateRecovery\?\.requestId,\s+player\.id,/u)
  assert.match(submitAction, /manualRoll: narrateRecovery\?\.manualRoll/u)
  assert.match(submitAction, /uncertain = isTacticalCommandUnknown\(error\)\s+if \(narrateRecovery && !uncertain\) clearPendingNarrate\(narrateStorage, narrateStorageKey, narrateRecovery\.requestId\)/u)
  // Контекст карточки в теле и в намерении — одни и те же значения.
  for (const field of ['clarificationId', 'supersedesCheckId', 'supersedesProposalId', 'questionCheckId', 'questionProposalId']) {
    assert.match(submitAction, new RegExp(`${field}: intent\\.${field}`, 'u'), field)
  }
  // Ключ больше не рождается внутри narrateWithAgent на каждый вызов.
  assert.doesNotMatch(submitAction, /undefined,\s+undefined,\s+player\.id/u)
})

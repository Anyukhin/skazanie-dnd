import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearPendingNarrate,
  isTacticalCommandUnknown,
  narrateIntentMatches,
  narrateRecoveryFor,
  parsePendingNarrate,
  parsePendingTacticalCommand,
  pendingNarrateStorageKey,
  pendingTacticalCommandStorageKey,
  readPendingNarrate,
  readPendingTacticalCommand,
  tacticalCommandRequest,
  writePendingNarrate,
  writePendingTacticalCommand,
} from '../src/tactical-command-recovery.mjs'

const pending = {
  campaignId: 'RECOVERY-1',
  requestId: 'same-request-id',
  kind: 'tactical',
  command: { command_type: 'MoveActor', actor_id: 'hero', to: { x: 3, y: 4 } },
  message: 'Переместить героя на клетку 3, 4',
  manualRoll: false,
}

test('неизвестный transport-исход повторяет тот же tactical body и idempotency key', async () => {
  const first = tacticalCommandRequest(pending)
  const sent = []
  const fakeTransport = async (path, init) => {
    sent.push({ path, init, body: JSON.parse(String(init.body)) })
    if (sent.length === 1) throw Object.assign(new Error('network vanished'), { name: 'TypeError' })
    return new Response(JSON.stringify({ authoritative_state: { state_version: 2 } }), { status: 200 })
  }

  await assert.rejects(() => fakeTransport(first.path, first.init), /network vanished/u)
  assert.equal(isTacticalCommandUnknown(Object.assign(new Error('network vanished'), { name: 'TypeError' })), true)

  const retry = tacticalCommandRequest(pending)
  const response = await fakeTransport(retry.path, retry.init)
  assert.equal(response.status, 200)
  assert.equal(sent.length, 2)
  assert.equal(sent[0].path, sent[1].path)
  assert.deepEqual(sent[0].body, sent[1].body)
  assert.equal(sent[1].body.idempotency_key, pending.requestId)
  assert.deepEqual(sent[1].body.command, pending.command)
})

test('ответ HTTP с известным отказом не считается неопределённым', () => {
  const error = Object.assign(new Error('ход уже сделан'), { status: 409, code: 'STATE_VERSION_CONFLICT' })
  assert.equal(isTacticalCommandUnknown(error), false)
  assert.equal(isTacticalCommandUnknown(Object.assign(new Error('проекция упала'), { status: 500 })), true)
})

test('pending команда хранится только под ключом аккаунта и кампании', () => {
  const storage = new Map()
  const adapter = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  }
  const key = pendingTacticalCommandStorageKey('account-a', pending.campaignId)
  assert.ok(key)
  writePendingTacticalCommand(adapter, key, pending)
  assert.deepEqual(parsePendingTacticalCommand(adapter.getItem(key)), pending)
  assert.equal(pendingTacticalCommandStorageKey('account-b', pending.campaignId) === key, false)
})

test('повтор отдыха сохраняет expected_state_version в теле, а ключ — в заголовке', () => {
  const request = tacticalCommandRequest({
    ...pending,
    kind: 'rest',
    command: { command_type: 'CompleteRest', actor_id: 'hero', expected_state_version: 17 },
  })
  assert.equal(request.init.headers['X-Idempotency-Key'], pending.requestId)
  assert.equal(request.body.idempotency_key, undefined)
  assert.deepEqual(request.body.command, { command_type: 'CompleteRest', actor_id: 'hero', expected_state_version: 17 })
})

test('ошибка после commit, тайм-аут и потеря тела ответа сохраняют право на безопасный повтор', () => {
  for (const error of [
    Object.assign(new Error('Внутренняя ошибка'), { status: 500, code: 'INTERNAL_ERROR' }),
    Object.assign(new Error('Прокси не дождался ответа'), { status: 504 }),
    Object.assign(new Error('Запрос не завершился вовремя'), { name: 'RequestTimeoutError' }),
    new SyntaxError('Ответ прервался при чтении JSON'),
  ]) assert.equal(isTacticalCommandUnknown(error), true)
})

// --- Свободное действие /api/narrate (аудит PR #131, REC-01) ---------------

function memoryStorage() {
  const map = new Map()
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  }
}

const narrateIntent = {
  campaignId: 'NARRATE-1',
  actorId: 'hero-a',
  action: 'Проверяю силу',
  requestKind: 'action',
}

/**
 * Сервер с настоящей идемпотентностью по ключу: новый ключ — новый commit с
 * новым броском, прежний — replay. `dropFirst` моделирует пробу аудита
 * (round-4/22): commit уже записан, а ответ клиенту потерян.
 */
function fakeNarrateServer({ dropFirst = null } = {}) {
  const commits = new Map()
  const sent = []
  return {
    commits,
    sent,
    async transport(body) {
      sent.push(body)
      const replay = commits.has(body.idempotency_key)
      if (!replay) commits.set(body.idempotency_key, { event_type: 'AbilityCheckResolved', roll_id: `roll-${commits.size + 1}` })
      if (dropFirst && sent.length === 1) throw dropFirst
      return { idempotent_replay: replay, mechanics: [commits.get(body.idempotency_key)] }
    },
  }
}

/**
 * Тот же порядок шагов, что у `submitAction` (src/useGameSession.ts): запись
 * до отправки, снятие после ответа или авторитетного отказа, сохранение при
 * неизвестном исходе. Сам хук сверяется по исходнику в
 * test/narrate-retry-recovery.test.mjs.
 */
let narrateKeySequence = 0
async function submitNarrate(storage, key, intent, transport, { manualRoll = false } = {}) {
  let recovery = null
  try {
    recovery = narrateRecoveryFor(readPendingNarrate(storage, key), intent, {
      newKey: () => `narrate-key-${++narrateKeySequence}`,
      manualRoll,
    })
    writePendingNarrate(storage, key, recovery)
    const result = await transport({
      action: intent.action,
      idempotency_key: recovery.requestId,
      ...(recovery.manualRoll ? { manual_roll: true } : {}),
    })
    clearPendingNarrate(storage, key, recovery.requestId)
    return { ok: true, result, recovery }
  } catch (error) {
    if (recovery && !isTacticalCommandUnknown(error)) clearPendingNarrate(storage, key, recovery.requestId)
    return { ok: false, error, recovery }
  }
}

test('narrate: неизвестный исход хранит ключ, и повтор той же заявки даёт один commit', async () => {
  for (const lost of [
    new TypeError('fetch failed'),
    Object.assign(new Error('Прокси отдал 503 после commit'), { status: 503, code: 'PROXY_DROP_AFTER_COMMIT' }),
    Object.assign(new Error('Рассказчик не ответил вовремя'), { name: 'RequestTimeoutError' }),
    new SyntaxError('Ответ прервался при чтении JSON'),
  ]) {
    const storage = memoryStorage()
    const key = pendingNarrateStorageKey('account-a', narrateIntent.campaignId)
    const server = fakeNarrateServer({ dropFirst: lost })

    const first = await submitNarrate(storage, key, narrateIntent, server.transport)
    assert.equal(first.ok, false, lost.message)
    assert.equal(server.commits.size, 1, 'первый запрос успел записать ход')
    assert.equal(readPendingNarrate(storage, key)?.requestId, first.recovery.requestId, 'запись пережила неизвестный исход')

    const retry = await submitNarrate(storage, key, { ...narrateIntent }, server.transport)
    assert.equal(retry.ok, true)
    assert.equal(server.sent[1].idempotency_key, server.sent[0].idempotency_key)
    assert.deepEqual(server.sent[1], server.sent[0], 'повтор отправляет то же тело')
    assert.equal(retry.result.idempotent_replay, true)
    assert.equal(server.commits.size, 1, 'второй проверки и второго броска нет')
    assert.equal(readPendingNarrate(storage, key), null, 'известный исход снимает запись')
  }
})

test('narrate: без сохранённого ключа тот же сценарий записывал второй commit (контроль пробы)', async () => {
  // Так вёл себя клиент до правки: ключ рождался на каждый вызов. Хранилище
  // недоступно — записи нет, и повтор получает новый ключ.
  const server = fakeNarrateServer({ dropFirst: new TypeError('fetch failed') })
  await submitNarrate(null, null, narrateIntent, server.transport)
  await submitNarrate(null, null, narrateIntent, server.transport)
  assert.notEqual(server.sent[1].idempotency_key, server.sent[0].idempotency_key)
  assert.equal(server.commits.size, 2)
})

test('narrate: другое намерение получает новый ключ и вытесняет запись', () => {
  const pending = narrateRecoveryFor(null, narrateIntent, { newKey: () => 'original-key' })
  assert.equal(pending.requestId, 'original-key')
  for (const [label, changed] of [
    ['текст', { action: 'Проверяю ловкость' }],
    ['герой', { actorId: 'hero-b' }],
    ['кампания', { campaignId: 'NARRATE-2' }],
    ['вид реплики', { requestKind: 'question' }],
    ['собеседник', { npcId: 'npc-guard' }],
    ['уточнение', { clarificationId: 'clarification-1' }],
    ['правка карточки проверки', { supersedesCheckId: 'check-1' }],
    ['правка манёвра', { supersedesProposalId: 'proposal-1' }],
    ['вопрос к карточке', { questionCheckId: 'check-2' }],
    ['вопрос к манёвру', { questionProposalId: 'proposal-2' }],
  ]) {
    const intent = { ...narrateIntent, ...changed }
    assert.equal(narrateIntentMatches(pending, intent), false, label)
    const next = narrateRecoveryFor(pending, intent, { newKey: () => `new-key-${label}` })
    assert.equal(next.requestId, `new-key-${label}`, label)
  }

  const storage = memoryStorage()
  const key = pendingNarrateStorageKey('account-a', narrateIntent.campaignId)
  writePendingNarrate(storage, key, pending)
  const other = narrateRecoveryFor(readPendingNarrate(storage, key), { ...narrateIntent, action: 'Открываю дверь' }, { newKey: () => 'door-key' })
  writePendingNarrate(storage, key, other)
  assert.equal(readPendingNarrate(storage, key).requestId, 'door-key')
  assert.equal(readPendingNarrate(storage, key).action, 'Открываю дверь')
})

test('narrate: разница в пробелах и формах Юникода — та же заявка, как в серверном отпечатке', () => {
  const pending = narrateRecoveryFor(null, narrateIntent, { newKey: () => 'same-key' })
  for (const action of ['  Проверяю   силу ', 'Проверяю силу', 'Проверяю\nсилу']) {
    assert.equal(narrateIntentMatches(pending, { ...narrateIntent, action }), true, JSON.stringify(action))
    assert.equal(narrateRecoveryFor(pending, { ...narrateIntent, action }, { newKey: () => 'unexpected' }).requestId, 'same-key')
  }
  // Регистр кампании не делает заявку другой: код комнаты сравнивается в верхнем регистре.
  assert.equal(narrateIntentMatches(pending, { ...narrateIntent, campaignId: 'narrate-1' }), true)
})

test('narrate: известный исход снимает запись, следующая такая же фраза — новый ход', async () => {
  for (const known of [
    null,
    Object.assign(new Error('Другой игрок уже изменил состояние'), { status: 409, code: 'STATE_VERSION_CONFLICT' }),
    Object.assign(new Error('Слишком много ходов'), { status: 429 }),
    Object.assign(new Error('Неизвестный тип реплики'), { status: 400, code: 'REQUEST_KIND_INVALID' }),
  ]) {
    const storage = memoryStorage()
    const key = pendingNarrateStorageKey('account-a', narrateIntent.campaignId)
    const transport = known ? async () => { throw known } : async () => ({ idempotent_replay: false })
    const first = await submitNarrate(storage, key, narrateIntent, transport)
    assert.equal(first.ok, known === null)
    assert.equal(readPendingNarrate(storage, key), null, known?.message ?? 'успех')
    const next = await submitNarrate(storage, key, narrateIntent, async () => ({ idempotent_replay: false }))
    assert.notEqual(next.recovery.requestId, first.recovery.requestId)
  }
})

test('narrate: режим броска повторяется таким, каким ушла первая попытка', async () => {
  const storage = memoryStorage()
  const key = pendingNarrateStorageKey('account-a', narrateIntent.campaignId)
  const server = fakeNarrateServer({ dropFirst: new TypeError('fetch failed') })
  await submitNarrate(storage, key, narrateIntent, server.transport, { manualRoll: false })
  // Между попытками игрок выключил автобросок: это не новая заявка, а повтор.
  await submitNarrate(storage, key, narrateIntent, server.transport, { manualRoll: true })
  assert.equal(server.sent[0].manual_roll, undefined)
  assert.deepEqual(server.sent[1], server.sent[0])
  assert.equal(server.commits.size, 1)
})

test('narrate: поздний ответ прежней заявки не стирает запись новой', () => {
  const storage = memoryStorage()
  const key = pendingNarrateStorageKey('account-a', narrateIntent.campaignId)
  const older = narrateRecoveryFor(null, narrateIntent, { newKey: () => 'older' })
  const newer = narrateRecoveryFor(older, { ...narrateIntent, action: 'Открываю дверь' }, { newKey: () => 'newer' })
  writePendingNarrate(storage, key, newer)
  clearPendingNarrate(storage, key, older.requestId)
  assert.equal(readPendingNarrate(storage, key)?.requestId, 'newer')
  clearPendingNarrate(storage, key, newer.requestId)
  assert.equal(readPendingNarrate(storage, key), null)
})

test('narrate: запись лежит под аккаунтом и кампанией и не делит слот с командой доски', () => {
  const key = pendingNarrateStorageKey('account-a', 'NARRATE-1')
  assert.ok(key)
  assert.equal(pendingNarrateStorageKey('account-a', 'narrate-1'), key)
  assert.notEqual(pendingNarrateStorageKey('account-b', 'NARRATE-1'), key)
  assert.notEqual(pendingNarrateStorageKey('account-a', 'NARRATE-2'), key)
  assert.equal(pendingNarrateStorageKey('', 'NARRATE-1'), null)
  assert.equal(pendingNarrateStorageKey('account-a', ''), null)
  // Незавершённая команда доски блокирует новые команды доски; свободное
  // действие в её слот не попадает и не попадает в её кнопку «повторить».
  assert.notEqual(pendingTacticalCommandStorageKey('account-a', 'NARRATE-1'), key)

  const storage = memoryStorage()
  const recovery = narrateRecoveryFor(null, narrateIntent, { newKey: () => 'stored-key' })
  writePendingNarrate(storage, key, recovery)
  assert.deepEqual(parsePendingNarrate(storage.getItem(key)), recovery)
  assert.equal(readPendingTacticalCommand(storage, key), null, 'запись narrate не читается как команда доски')
  assert.equal(parsePendingNarrate('{"schema_version":2,"pending":{}}'), null)
  assert.equal(parsePendingNarrate('не json'), null)
  assert.equal(narrateRecoveryFor(null, { ...narrateIntent, action: '   ' }, { newKey: () => 'unused' }), null)
})

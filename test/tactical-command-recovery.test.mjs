import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearPendingNarrate,
  clearPendingPartyDecision,
  isTacticalCommandUnknown,
  narrateIntentMatches,
  narrateRecoveryFor,
  parsePendingNarrate,
  parsePendingTacticalCommand,
  partyDecisionIntentMatches,
  partyDecisionRecoveryFor,
  partyDecisionRequest,
  pendingNarrateStorageKey,
  pendingPartyDecisionStorageKey,
  pendingTacticalCommandStorageKey,
  readPendingNarrate,
  readPendingPartyDecision,
  readPendingTacticalCommand,
  tacticalCommandRequest,
  writePendingNarrate,
  writePendingPartyDecision,
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

// --- Голос и общий бросок отряда (аудит PR #131, REC-02) ------------------

/**
 * Поддельный сервер решений отряда с той же идемпотентностью, что у маршрутов
 * `party-decisions/:id/votes` и `/roll` (server/index.mjs): новый ключ — новый
 * commit, прежний — replay. Голос до кворума можно заменить, а общий бросок
 * закрывает решение — новый ключ после него получает 409. `dropFirst`
 * моделирует пробу аудита (round-6/30): commit записан, ответ потерян.
 */
function fakePartyDecisionServer({ dropFirst = null } = {}) {
  const commits = new Map()
  const sent = []
  let closed = false
  return {
    commits,
    sent,
    async transport(path, init) {
      const body = JSON.parse(String(init.body))
      sent.push({ path, body })
      const roll = path.endsWith('/roll')
      if (!commits.has(body.idempotency_key)) {
        if (roll && closed) throw Object.assign(new Error('Решение уже принято'), { status: 409, code: 'PARTY_DECISION_CLOSED' })
        commits.set(body.idempotency_key, roll
          ? { event_type: 'DieRolled', total: 11 + commits.size }
          : { event_type: body.abstain ? 'PartyDecisionAbstained' : 'PartyVoteCast', option_id: body.option_id ?? null })
        if (roll) closed = true
      }
      if (dropFirst && sent.length === 1) throw dropFirst
      return { state: { sessionCode: 'PARTY-1' }, mechanics: [commits.get(body.idempotency_key)] }
    },
  }
}

const voteIntent = { campaignId: 'PARTY-1', interactionId: 'decision-1', actorId: 'hero-a', operation: 'vote', optionId: 'north' }
const rollIntent = { campaignId: 'PARTY-1', interactionId: 'decision-2', actorId: 'hero-a', operation: 'roll' }

/**
 * Те же шаги, что у `sendPartyDecision` (src/useGameSession.ts): запись до
 * отправки, снятие после ответа или авторитетного отказа, сохранение при
 * неизвестном исходе. Сам хук прогоняется в test/game-session-recovery.test.mjs.
 */
let partyKeySequence = 0
async function sendParty(storage, key, intent, transport) {
  const recovery = partyDecisionRecoveryFor(readPendingPartyDecision(storage, key), intent, {
    newKey: () => `party-key-${++partyKeySequence}`,
  })
  writePendingPartyDecision(storage, key, recovery)
  const request = partyDecisionRequest(recovery)
  try {
    const result = await transport(request.path, request.init)
    clearPendingPartyDecision(storage, key, recovery.requestId)
    return { ok: true, result, recovery }
  } catch (error) {
    if (!isTacticalCommandUnknown(error)) clearPendingPartyDecision(storage, key, recovery.requestId)
    return { ok: false, error, recovery }
  }
}

test('REC-02: повтор голоса после неизвестного исхода уходит с прежним ключом — второго PartyVoteCast нет', async () => {
  for (const lost of [
    new TypeError('fetch failed'),
    Object.assign(new Error('Прокси отдал 502 после commit'), { status: 502 }),
    new SyntaxError('Ответ прервался при чтении JSON'),
  ]) {
    const storage = memoryStorage()
    const key = pendingPartyDecisionStorageKey('account-a', voteIntent.campaignId)
    const server = fakePartyDecisionServer({ dropFirst: lost })

    const first = await sendParty(storage, key, voteIntent, server.transport)
    assert.equal(first.ok, false, lost.message)
    assert.equal(server.commits.size, 1, 'первый голос записан')
    assert.equal(readPendingPartyDecision(storage, key)?.requestId, first.recovery.requestId, 'запись пережила неизвестный исход')

    const retry = await sendParty(storage, key, { ...voteIntent }, server.transport)
    assert.equal(retry.ok, true)
    assert.equal(server.sent[1].path, server.sent[0].path)
    assert.deepEqual(server.sent[1].body, server.sent[0].body, 'повтор отправляет то же тело с тем же ключом')
    assert.equal(server.commits.size, 1, 'второго PartyVoteCast нет')
    assert.equal(readPendingPartyDecision(storage, key), null, 'принятый ответ снимает запись')
  }
})

test('REC-02: повтор общего броска после потери ответа получает выпавшую кость, а не 409', async () => {
  const storage = memoryStorage()
  const key = pendingPartyDecisionStorageKey('account-a', rollIntent.campaignId)
  const server = fakePartyDecisionServer({ dropFirst: new TypeError('fetch failed') })

  const first = await sendParty(storage, key, rollIntent, server.transport)
  assert.equal(first.ok, false)
  const retry = await sendParty(storage, key, rollIntent, server.transport)
  assert.equal(retry.ok, true, 'тот же ключ — replay записанного броска')
  assert.equal(server.sent[1].body.idempotency_key, server.sent[0].body.idempotency_key)
  assert.match(server.sent[1].path, /\/party-decisions\/decision-2\/roll$/u)
  assert.equal(retry.result.mechanics[0].event_type, 'DieRolled')
  assert.equal(server.commits.size, 1, 'вторая кость не брошена')
})

test('REC-02: без сохранённого ключа тот же сценарий давал второй голос и 409 на броске (контроль пробы)', async () => {
  const vote = fakePartyDecisionServer({ dropFirst: new TypeError('fetch failed') })
  await sendParty(null, null, voteIntent, vote.transport)
  await sendParty(null, null, voteIntent, vote.transport)
  assert.notEqual(vote.sent[1].body.idempotency_key, vote.sent[0].body.idempotency_key)
  assert.equal(vote.commits.size, 2, 'лишний PartyVoteCast')

  const roll = fakePartyDecisionServer({ dropFirst: new TypeError('fetch failed') })
  await sendParty(null, null, rollIntent, roll.transport)
  const second = await sendParty(null, null, rollIntent, roll.transport)
  assert.equal(second.error?.status, 409)
})

test('REC-02: другая операция получает новый ключ и вытесняет запись', () => {
  const pending = partyDecisionRecoveryFor(null, voteIntent, { newKey: () => 'vote-key' })
  assert.equal(pending.requestId, 'vote-key')
  assert.equal(partyDecisionRecoveryFor(pending, { ...voteIntent, campaignId: 'party-1' }, { newKey: () => 'unexpected' }).requestId, 'vote-key',
    'регистр кода кампании не делает операцию другой')
  for (const [label, changed] of [
    ['другой вариант — игрок передумал', { optionId: 'south' }],
    ['отказ от голоса', { operation: 'abstain', optionId: undefined }],
    ['общий бросок', { operation: 'roll', optionId: undefined }],
    ['другое решение', { interactionId: 'decision-9' }],
    ['другой герой', { actorId: 'hero-b' }],
    ['другая кампания', { campaignId: 'PARTY-2' }],
  ]) {
    const intent = { ...voteIntent, ...changed }
    assert.equal(partyDecisionIntentMatches(pending, intent), false, label)
    assert.equal(partyDecisionRecoveryFor(pending, intent, { newKey: () => `new-${label}` }).requestId, `new-${label}`, label)
  }
})

test('REC-02: известный исход снимает запись, следующая такая же операция — новый ключ', async () => {
  for (const known of [
    null,
    Object.assign(new Error('Решение уже принято'), { status: 409, code: 'PARTY_DECISION_CLOSED' }),
    Object.assign(new Error('Этот герой не принадлежит вашему аккаунту'), { status: 403, code: 'ACTOR_FORBIDDEN' }),
  ]) {
    const storage = memoryStorage()
    const key = pendingPartyDecisionStorageKey('account-a', voteIntent.campaignId)
    const transport = known ? async () => { throw known } : async () => ({ state: { sessionCode: 'PARTY-1' } })
    const first = await sendParty(storage, key, voteIntent, transport)
    assert.equal(first.ok, known === null)
    assert.equal(readPendingPartyDecision(storage, key), null, known?.message ?? 'успех')
    const next = await sendParty(storage, key, voteIntent, async () => ({ state: {} }))
    assert.notEqual(next.recovery.requestId, first.recovery.requestId)
  }
})

test('REC-02: тело запроса совпадает с прежним форматом клиента, поздний ответ не стирает чужую запись', () => {
  assert.deepEqual(partyDecisionRequest({ ...voteIntent, requestId: 'k1' }).body, { actor_id: 'hero-a', option_id: 'north', idempotency_key: 'k1' })
  assert.deepEqual(partyDecisionRequest({ ...voteIntent, operation: 'abstain', optionId: undefined, requestId: 'k2' }).body, { actor_id: 'hero-a', abstain: true, idempotency_key: 'k2' })
  assert.deepEqual(partyDecisionRequest({ ...rollIntent, requestId: 'k3' }).body, { actor_id: 'hero-a', idempotency_key: 'k3' })
  assert.equal(partyDecisionRequest({ ...rollIntent, requestId: 'k3' }).path, '/api/campaigns/PARTY-1/party-decisions/decision-2/roll')
  assert.equal(partyDecisionRequest({ ...voteIntent, requestId: 'k1' }).path, '/api/campaigns/PARTY-1/party-decisions/decision-1/votes')
  assert.equal(partyDecisionRequest({ ...voteIntent, optionId: '', requestId: 'k1' }), null, 'голос без варианта не собирается')

  const storage = memoryStorage()
  const key = pendingPartyDecisionStorageKey('account-a', 'PARTY-1')
  const older = partyDecisionRecoveryFor(null, voteIntent, { newKey: () => 'older' })
  const newer = partyDecisionRecoveryFor(older, { ...voteIntent, optionId: 'south' }, { newKey: () => 'newer' })
  writePendingPartyDecision(storage, key, newer)
  clearPendingPartyDecision(storage, key, older.requestId)
  assert.equal(readPendingPartyDecision(storage, key)?.requestId, 'newer')

  // Слот отдельный: не делит место ни с командой доски, ни со свободным действием.
  assert.ok(key)
  assert.notEqual(key, pendingTacticalCommandStorageKey('account-a', 'PARTY-1'))
  assert.notEqual(key, pendingNarrateStorageKey('account-a', 'PARTY-1'))
  assert.notEqual(key, pendingPartyDecisionStorageKey('account-b', 'PARTY-1'))
  assert.equal(pendingPartyDecisionStorageKey('', 'PARTY-1'), null)
  assert.equal(readPendingNarrate(storage, key), null, 'запись голоса не читается как свободное действие')
})

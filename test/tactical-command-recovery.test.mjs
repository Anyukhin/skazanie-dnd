import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isTacticalCommandUnknown,
  parsePendingTacticalCommand,
  pendingTacticalCommandStorageKey,
  tacticalCommandRequest,
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

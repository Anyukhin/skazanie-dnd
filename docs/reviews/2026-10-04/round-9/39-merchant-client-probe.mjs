// Исполняются настоящие callback-и, но React, сеть и writers заменены.
// Это проверка клиентских ветвей, не HTTP/браузерное доказательство сделки.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const source = readFileSync(join(root, 'src/useGameSession.ts'), 'utf8')
const start = source.indexOf('  const loadMerchant = useCallback')
const end = source.indexOf('  const bargainWithMerchant = useCallback')
assert.ok(start > 0 && end > start)
const build = mkdtempSync(join(tmpdir(), 'skazanie-merchant-client-probe-'))
process.once('exit', () => rmSync(build, { recursive: true, force: true }))
writeFileSync(join(build, 'callbacks.ts'), source.slice(start, end))
const compiled = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
  '--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'ESNext', '--outDir', build,
  join(build, 'callbacks.ts')], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
const callbacks = readFileSync(join(build, 'callbacks.js'), 'utf8')

const command = { command_type: 'BuyItem', actor_id: 'hero', stock_id: 'stock', quantity: 1 }
const goodView = { merchant: { id: 'shop' }, actor_id: 'hero', expected_state_version: 2 }
const goodResponse = () => ({ ok: true, status: 200, json: async () => ({
  authoritative_state: { sessionCode: 'A', state_version: 2 }, merchant_view: goodView, room_version: 2,
}) })

function harness(fetchResponse) {
  const calls = [], writes = []
  let sequence = 0
  const context = {
    useCallback: callback => callback,
    stateRef: { current: { sessionCode: 'A', state_version: 1 } },
    merchantEpoch: { current: 0 }, merchantBusyRef: { current: false },
    merchantView: { merchant: { id: 'shop' }, actor_id: 'hero', expected_state_version: 1 },
    roomVersion: { current: 1 }, latestRoomVersion: Math.max,
    commandId: () => `request-${++sequence}`,
    fetch: (url, init) => { calls.push({ url, init }); return fetchResponse(calls.length) },
    mergeTacticalCommandState: (_current, authoritative) => authoritative,
    responseCommandError: async () => new Error('HTTP-отказ'),
    ...Object.fromEntries(['setMerchantBusy', 'setMerchantError', 'setMerchantNarration', 'setMerchantView', 'applyRemote']
      .map(name => [name, value => writes.push({ name, value })])),
  }
  const functions = new Function(...Object.keys(context), `${callbacks}\nreturn { loadMerchant, executeMerchantCommand }`)(...Object.values(context))
  return { ...functions, context, calls, writes }
}

async function failureCase(name, fetchResponse, expectedMessage) {
  const h = harness(fetchResponse)
  await h.executeMerchantCommand('shop', command)
  assert.equal(h.context.merchantBusyRef.current, false)
  assert.equal(h.writes.some(write => write.name === 'applyRemote'), false)
  const error = h.writes.findLast(write => write.name === 'setMerchantError')?.value
  assert.match(error, expectedMessage)
  return { name, lock_released: true, partial_state_applied: false, error }
}

let rejectPending
const pendingResponse = new Promise((_resolve, reject) => { rejectPending = reject })
const pending = harness(() => pendingResponse)
const firstPending = pending.executeMerchantCommand('shop', command)
await pending.executeMerchantCommand('shop', command)
assert.equal(pending.calls.length, 1)
assert.equal(pending.context.merchantBusyRef.current, true)
assert.equal(Object.hasOwn(pending.calls[0].init, 'signal'), false)
rejectPending(new Error('Синтетический обрыв'))
await firstPending
assert.equal(pending.context.merchantBusyRef.current, false)

const failures = [
  await failureCase('invalid_json', () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('JSON') } }), /итоговое состояние/u),
  await failureCase('missing_merchant_view', () => Promise.resolve({ ok: true, status: 200, json: async () => ({ authoritative_state: { sessionCode: 'A', state_version: 2 } }) }), /котировки/u),
]
const valid = harness(() => Promise.resolve(goodResponse()))
await valid.executeMerchantCommand('shop', command)
assert.equal(valid.context.merchantBusyRef.current, false)
assert.equal(valid.context.roomVersion.current, 2)
assert.ok(valid.writes.some(write => write.name === 'applyRemote' && write.value.state_version === 2))
assert.ok(valid.writes.some(write => write.name === 'setMerchantView' && write.value === goodView))

const retry = harness(attempt => attempt === 1 ? Promise.reject(new Error('Синтетический обрыв')) : Promise.resolve(goodResponse()))
await retry.executeMerchantCommand('shop', command)
await retry.executeMerchantCommand('shop', command)
const requests = retry.calls.map(call => JSON.parse(call.init.body))
assert.notEqual(requests[0].idempotency_key, requests[1].idempotency_key)
assert.deepEqual(requests[0].command, requests[1].command)
assert.equal(requests[1].command.expected_state_version, 1)

process.stdout.write(`${JSON.stringify({
  runtime_commit: 'cb045a8466f35696ff24abe9020d6f39dee89462',
  scope: 'callback execution with replaced React/network/state helpers; no server transaction',
  pending: { duplicate_click_sent: false, request_has_abort_signal: false, unlocked_after_rejection: true },
  failures,
  valid_response: { state_and_quote_applied: true, lock_released: true },
  retry_without_new_quote: { request_keys: requests.map(value => value.idempotency_key), expected_versions: requests.map(value => value.command.expected_state_version), second_purchase_proven: false },
}, null, 2)}\n`)

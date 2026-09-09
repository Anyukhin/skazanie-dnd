import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const shop = readFileSync(new URL('../src/MerchantView.tsx', import.meta.url), 'utf8')

// Исполняем сами callback хука с отложенным HTTP-ответом, без браузерной обвязки.
const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-merchant-session-'))
test.after(() => rmSync(buildDir, { recursive: true, force: true }))
const fragment = join(buildDir, 'callbacks.ts')
writeFileSync(fragment, session.slice(
  session.indexOf('  const loadMerchant = useCallback'),
  session.indexOf('  const bargainWithMerchant = useCallback'),
))
const compiled = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
  '--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'ESNext', '--outDir', buildDir, fragment,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
const callbacks = readFileSync(join(buildDir, 'callbacks.js'), 'utf8')

function merchantSession() {
  let respond
  const response = new Promise((resolve) => { respond = resolve })
  const writes = []
  const context = {
    useCallback: (callback) => callback,
    stateRef: { current: { sessionCode: 'OLD' } },
    merchantEpoch: { current: 0 },
    merchantBusyRef: { current: false },
    merchantView: { merchant: { id: 'shop' }, actor_id: 'hero', expected_state_version: 1 },
    roomVersion: { current: 1 },
    fetch: () => response,
    latestRoomVersion: Math.max,
    mergeTacticalCommandState: (_current, authoritative) => authoritative,
    commandId: () => 'request',
    responseCommandError: async () => new Error('Отказ'),
    ...Object.fromEntries(['setMerchantBusy', 'setMerchantError', 'setMerchantNarration', 'setMerchantView', 'applyRemote']
      .map((name) => [name, (value) => writes.push([name, value])])),
  }
  const hook = new Function(...Object.keys(context), `${callbacks}\nreturn { loadMerchant, executeMerchantCommand }`)(...Object.values(context))
  return { context, hook, writes, respond }
}

for (const method of ['loadMerchant', 'executeMerchantCommand']) {
  for (const ok of [true, false]) {
    test(`${method}: ответ прежнего посещения кампании не меняет новую витрину (${ok ? 'успех' : 'отказ'})`, async () => {
      const { context, hook, writes, respond } = merchantSession()
      const pending = method === 'loadMerchant'
        ? hook.loadMerchant('shop', 'hero')
        : hook.executeMerchantCommand('shop', { actor_id: 'hero', command_type: 'BuyItem' })
      // В том числе возвращение в ту же кампанию: одного сравнения sessionCode мало.
      context.merchantEpoch.current += 1
      context.merchantBusyRef.current = true
      writes.length = 0
      respond({ ok, status: ok ? 200 : 409, json: async () => ({
        merchant_view: context.merchantView, room_version: 9, authoritative_state: { sessionCode: 'OLD' },
      }) })
      await pending
      assert.deepEqual(writes, [])
      assert.equal(context.roomVersion.current, 1)
      assert.equal(context.merchantBusyRef.current, true, 'старый finally не снимает блокировку нового запроса')
    })
  }
}

test('свежий ответ торговли применяется к своей кампании', async () => {
  const { context, hook, writes, respond } = merchantSession()
  const pending = hook.loadMerchant('shop', 'hero')
  respond({ ok: true, json: async () => ({ merchant_view: context.merchantView, room_version: 2, authoritative_state: { sessionCode: 'OLD' } }) })
  await pending
  assert.equal(context.roomVersion.current, 2)
  assert.ok(writes.some(([name]) => name === 'applyRemote'))
  assert.ok(writes.some(([name, view]) => name === 'setMerchantView' && view === context.merchantView))
  assert.equal(context.merchantBusyRef.current, false)
  const switchSource = session.slice(session.indexOf('  const switchCampaign ='), session.indexOf('  const loadMerchant ='))
  assert.match(switchSource, /merchantEpoch\.current \+= 1/u)
})

test('открытие обновляет котировки один раз, ответ сделки не вызывает лишний GET', () => {
  const start = shop.indexOf('    const autoLoadKey =')
  const end = shop.indexOf('  }, [busy,', start)
  assert.ok(start > 0 && end > start)
  const runEffect = new Function('sceneLocation', 'stateVersion', 'merchant', 'player', 'lastAutoLoadKey', 'busy', 'onLoad', 'viewMatchesContext', shop.slice(start, end))
  const loaded = []
  const cursor = { current: '' }
  const tick = (version, matches, busy = false) => runEffect('Рынок', version, { id: 'shop' }, { id: 'hero' }, cursor, busy, (...args) => loaded.push(args), matches)
  tick(1, true)
  tick(1, true)
  tick(2, true)
  assert.equal(loaded.length, 1, 'котировка после сделки уже свежая')
  tick(3, false, true)
  assert.equal(loaded.length, 1)
  tick(3, false)
  assert.deepEqual(loaded, [['shop', 'hero'], ['shop', 'hero']], 'чужое изменение требует обновления')
})

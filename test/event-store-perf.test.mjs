import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileEventStore } from '../server/event-store.mjs'

// Инкрементальный индекс журнала и ограниченный кэш головы
// (`server/event-store.mjs`, `_readCommitFiles`, `_rememberRecent`): прогретый
// экземпляр хранилища обязан вести себя так же, как свежий, — видеть чужие
// коммиты, замечать порчу и потерю файлов и требовать восстановления.

function reducer(state, event) {
  const next = structuredClone(state)
  if (event.event_type === 'HealingApplied') next.hp = Number(next.hp || 0) + Number(event.payload.amount || 0)
  return next
}

function temporaryRoot(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-event-store-perf-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  return rootDir
}

function heal(campaignId, version, key, extra = {}) {
  return {
    campaign_id: campaignId, expected_state_version: version, idempotency_key: key,
    events: [{ event_type: 'HealingApplied', payload: { amount: 1 } }], ...extra,
  }
}

function campaignDirectory(rootDir, campaignId) {
  const campaigns = join(rootDir, 'campaigns')
  const name = readdirSync(campaigns).find((entry) => entry.startsWith(`${campaignId}-`))
  assert.ok(name, `каталог кампании ${campaignId} не найден`)
  return join(campaigns, name)
}

/** Сколько файлов журнала открыто для чтения за время `operation`. */
async function countCommitReads(operation) {
  const originalOpen = fs.openSync
  const originalRead = fs.readFileSync
  let reads = 0
  const isCommit = (file) => typeof file === 'string' && /[\\/]events[\\/]\d{16}-\d{16}-/.test(file)
  fs.openSync = function patchedOpen(file, flags, ...rest) {
    if (isCommit(file) && (flags === 'r' || flags === undefined)) reads += 1
    return originalOpen.call(this, file, flags, ...rest)
  }
  fs.readFileSync = function patchedRead(file, ...rest) {
    if (isCommit(file)) reads += 1
    return originalRead.call(this, file, ...rest)
  }
  syncBuiltinESMExports()
  try {
    await operation()
  } finally {
    fs.openSync = originalOpen
    fs.readFileSync = originalRead
    syncBuiltinESMExports()
  }
  return reads
}

test('прогретый индекс читает только новые файлы журнала и видит чужой коммит', async (t) => {
  const rootDir = temporaryRoot(t)
  const store = new FileEventStore({ rootDir, reducer, snapshotEvery: 0 })
  await store.initializeCampaign({ campaign_id: 'warm', initial_state: { hp: 0 } })
  for (let version = 0; version < 5; version += 1) await store.commit(heal('warm', version, `heal-${version}`))
  assert.equal((await store.load('warm')).state.hp, 5)

  assert.equal(await countCommitReads(() => store.load('warm')), 0, 'неизменный журнал не перечитывается')
  assert.equal(await countCommitReads(() => store.getMetadata('warm')), 0)

  const other = new FileEventStore({ rootDir, reducer, snapshotEvery: 0 })
  await other.commit(heal('warm', 5, 'heal-other'))
  let loaded
  assert.equal(await countCommitReads(async () => { loaded = await store.load('warm') }), 1, 'разобран только новый файл')
  assert.equal(loaded.state_version, 6)
  assert.equal(loaded.state.hp, 6)
  assert.equal((await store.getByIdempotencyKey('warm', 'heal-other')).state_version, 6)
  assert.equal((await store.commit(heal('warm', 6, 'heal-6'))).state_version, 7)
  assert.equal((await other.load('warm')).state.hp, 7)
})

test('прогретый индекс замечает порчу файла на месте в середине журнала', async (t) => {
  const rootDir = temporaryRoot(t)
  const store = new FileEventStore({ rootDir, reducer, snapshotEvery: 1 })
  await store.initializeCampaign({ campaign_id: 'tamper', initial_state: { hp: 0 } })
  for (let version = 0; version < 4; version += 1) await store.commit(heal('tamper', version, `heal-${version}`))
  await store.load('tamper')
  const eventsDir = join(campaignDirectory(rootDir, 'tamper'), 'events')
  const middle = readdirSync(eventsDir).sort()[1]
  writeFileSync(join(eventsDir, middle), '{}')
  for (const operation of [
    () => store.load('tamper'),
    () => store.getMetadata('tamper'),
    () => store.getByIdempotencyKey('tamper', 'heal-0'),
    () => store.commit(heal('tamper', 4, 'heal-4')),
  ]) await assert.rejects(operation, { code: 'CORRUPT_EVENT_LOG', message: new RegExp(middle) })
})

test('прогретый индекс не скрывает потерю хвоста и seed: CAMPAIGN_RECOVERY_REQUIRED', async (t) => {
  const rootDir = temporaryRoot(t)
  const store = new FileEventStore({ rootDir, reducer, snapshotEvery: 0 })
  await store.initializeCampaign({ campaign_id: 'tail', initial_state: { hp: 0 } })
  for (let version = 0; version < 3; version += 1) await store.commit(heal('tail', version, `heal-${version}`))
  assert.equal((await store.load('tail')).state.hp, 3)
  const eventsDir = join(campaignDirectory(rootDir, 'tail'), 'events')
  rmSync(join(eventsDir, readdirSync(eventsDir).sort().at(-1)))
  for (const operation of [
    () => store.load('tail'),
    () => store.getMetadata('tail'),
    () => store.pendingProjection('tail', { withState: false }),
    () => store.commit(heal('tail', 2, 'heal-again')),
  ]) await assert.rejects(operation, { code: 'CAMPAIGN_RECOVERY_REQUIRED', reason: 'EVENT_LOG_TAIL_MISSING' })

  await store.initializeCampaign({ campaign_id: 'seed', initial_state: { hp: 0 } })
  await store.commit(heal('seed', 0, 'heal-0'))
  assert.equal((await store.replay('seed', { use_snapshots: false })).state.hp, 1)
  rmSync(join(campaignDirectory(rootDir, 'seed'), 'snapshots', '0000000000000000.json'))
  await assert.rejects(store.replay('seed', { use_snapshots: false }), { code: 'CAMPAIGN_RECOVERY_REQUIRED', reason: 'SEED_SNAPSHOT_MISSING' })
})

test('исчезнувший файл в середине журнала — разрыв, а не тихий пропуск', async (t) => {
  const rootDir = temporaryRoot(t)
  const store = new FileEventStore({ rootDir, reducer, snapshotEvery: 0 })
  await store.initializeCampaign({ campaign_id: 'hole', initial_state: { hp: 0 } })
  for (let version = 0; version < 3; version += 1) await store.commit(heal('hole', version, `heal-${version}`))
  await store.load('hole')
  const eventsDir = join(campaignDirectory(rootDir, 'hole'), 'events')
  rmSync(join(eventsDir, readdirSync(eventsDir).sort()[1]))
  await assert.rejects(store.load('hole'), { code: 'CORRUPT_EVENT_LOG' })
})

test('кэш головы и индекс ограничены и после вытеснения отдают точное состояние', async (t) => {
  assert.throws(() => new FileEventStore({ rootDir: temporaryRoot(t), reducer, headCacheLimit: 0 }), { code: 'INVALID_CONFIGURATION' })
  const rootDir = temporaryRoot(t)
  const store = new FileEventStore({ rootDir, reducer, snapshotEvery: 0, headCacheLimit: 2 })
  const campaigns = ['lru-a', 'lru-b', 'lru-c']
  for (const [index, campaignId] of campaigns.entries()) {
    await store.initializeCampaign({ campaign_id: campaignId, initial_state: { hp: index * 10 } })
    await store.commit(heal(campaignId, 0, 'heal-0'))
  }
  for (const campaignId of [...campaigns, ...campaigns]) await store.load(campaignId)
  assert.ok(store._headCache.size <= 2, `кэш головы держит ${store._headCache.size} кампаний`)
  assert.ok(store._commitIndex.size <= 2, `индекс журнала держит ${store._commitIndex.size} кампаний`)
  assert.equal(store._headCache.has('lru-a'), false, 'вытеснена давняя кампания')

  // Вытесненная кампания продвинута другим процессом: прогретый экземпляр
  // читает её заново и отдаёт новую голову.
  await new FileEventStore({ rootDir, reducer, snapshotEvery: 0 }).commit(heal('lru-a', 1, 'heal-1'))
  for (const [index, campaignId] of campaigns.entries()) {
    const loaded = await store.load(campaignId)
    assert.equal(loaded.state.hp, index * 10 + (campaignId === 'lru-a' ? 2 : 1), campaignId)
  }
  // Попадание освежает запись: только что прочитанная кампания не вытесняется первой.
  await store.load('lru-b')
  await store.load('lru-a')
  assert.deepEqual([...store._headCache.keys()], ['lru-b', 'lru-a'])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileEventStore,
  IdempotencyConflictError,
  VersionConflictError,
} from '../server/event-store.mjs'

function temporaryStore(t, options = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-event-store-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const reducer = (state, event) => {
    const next = structuredClone(state)
    if (event.event_type === 'DamageApplied') next.hp = Math.max(0, Number(next.hp || 0) - Number(event.payload.amount || 0))
    if (event.event_type === 'HealingApplied') next.hp = Number(next.hp || 0) + Number(event.payload.amount || 0)
    if (event.event_type === 'ObjectiveUpdated') next.objective = event.payload.objective
    if (event.event_type === 'ReducerFailure') throw new Error('reducer rejected event')
    return next
  }
  return { rootDir, reducer, store: new FileEventStore({ rootDir, reducer, ...options }) }
}

function campaignDirectory(rootDir) {
  const campaigns = join(rootDir, 'campaigns')
  const names = readdirSync(campaigns)
  assert.equal(names.length, 1)
  return join(campaigns, names[0])
}

test('imports a legacy snapshot once and can replay it without using snapshots', async (t) => {
  const { store } = temporaryStore(t)
  const legacy = { campaign: 'Ashes', hp: 17, messages: [{ id: 'm1', text: 'start' }] }

  const imported = await store.importLegacySnapshot({
    campaign_id: 'campaign-one',
    legacy_state: legacy,
    idempotency_key: 'legacy-import-1',
    ruleset_id: 'legacy_5e',
    ruleset_version: '2014',
  })

  assert.equal(imported.duplicate, false)
  assert.equal(imported.state_version, 1)
  assert.equal(imported.state.hp, 17)
  assert.equal(imported.state.state_version, 1)
  assert.equal(imported.events[0].event_type, 'LegacyStateImported')
  assert.equal(imported.metadata.ruleset_id, 'legacy_5e')

  const replayed = await store.replay('campaign-one', { use_snapshots: false })
  assert.deepEqual(replayed.state, imported.state)

  const duplicate = await store.importLegacySnapshot({
    campaign_id: 'campaign-one',
    legacy_state: legacy,
    idempotency_key: 'legacy-import-1',
  })
  assert.equal(duplicate.duplicate, true)
  assert.equal((await store.getEvents('campaign-one')).length, 1)
})

test('appends immutable event batches, snapshots, and replays historical versions', async (t) => {
  const { rootDir, reducer, store } = temporaryStore(t, { snapshotEvery: 2 })
  await store.initializeCampaign({ campaign_id: 'combat', initial_state: { hp: 10 } })

  const first = await store.commit({
    campaign_id: 'combat',
    expected_state_version: 0,
    idempotency_key: 'turn-1',
    command_id: 'damage-command',
    events: [{ event_type: 'DamageApplied', payload: { amount: 3 } }],
  })
  assert.equal(first.state.hp, 7)
  assert.equal(first.state_version, 1)

  const directory = campaignDirectory(rootDir)
  const firstEventFile = join(directory, 'events', readdirSync(join(directory, 'events'))[0])
  const firstEventContents = readFileSync(firstEventFile, 'utf8')

  const second = await store.commit({
    campaign_id: 'combat',
    expected_state_version: 1,
    idempotency_key: 'turn-2',
    events: [{ event_type: 'HealingApplied', payload: { amount: 2 } }],
  })
  assert.equal(second.state.hp, 9)
  assert.equal(second.state_version, 2)
  assert.equal(readFileSync(firstEventFile, 'utf8'), firstEventContents)
  assert.ok(readdirSync(join(directory, 'snapshots')).includes('0000000000000002.json'))

  const atOne = await store.load('combat', { atVersion: 1 })
  assert.equal(atOne.state.hp, 7)
  assert.equal(atOne.state.state_version, 1)
  assert.deepEqual((await store.getEvents('combat')).map((event) => event.event_type), ['DamageApplied', 'HealingApplied'])

  const reopened = new FileEventStore({ rootDir, reducer, snapshotEvery: 2 })
  const restored = await reopened.replay('combat')
  assert.equal(restored.state.hp, 9)
  assert.equal(restored.state_version, 2)
})

test('enforces idempotency before optimistic locking and rejects key reuse', async (t) => {
  const { store } = temporaryStore(t)
  await store.initializeCampaign({ campaign_id: 'locking', initial_state: { hp: 12 } })
  const request = {
    campaign_id: 'locking',
    expected_state_version: 0,
    idempotency_key: 'same-request',
    events: [{ event_type: 'DamageApplied', payload: { amount: 2 } }],
  }
  await store.commit(request)

  const retry = await store.commit(request)
  assert.equal(retry.duplicate, true)
  assert.equal(retry.state_version, 1)
  assert.equal(retry.state.hp, 10)

  await assert.rejects(
    store.commit({ ...request, events: [{ event_type: 'DamageApplied', payload: { amount: 8 } }] }),
    IdempotencyConflictError,
  )
  await assert.rejects(
    store.commit({ ...request, idempotency_key: 'new-request' }),
    (error) => error instanceof VersionConflictError && error.actual_state_version === 1,
  )
  assert.equal((await store.getEvents('locking')).length, 1)
})

test('пакет событий сохраняет снимок при превышении интервала, даже на некратной версии', async (t) => {
  const { rootDir, reducer, store } = temporaryStore(t, { snapshotEvery: 3 })
  await store.initializeCampaign({ campaign_id: 'batched-snapshots', initial_state: { hp: 10 } })
  const commit = (version, count, forceSnapshot = false) => store.commit({
    campaign_id: 'batched-snapshots', expected_state_version: version,
    idempotency_key: `batch-${version}`, forceSnapshot,
    events: Array.from({ length: count }, () => ({ event_type: 'HealingApplied', payload: { amount: 1 } })),
  })
  await commit(0, 2)
  assert.equal((await store.load('batched-snapshots')).events_applied, 2)
  const atFour = await commit(2, 2)
  assert.equal((await store.load('batched-snapshots')).events_applied, 0)
  const snapshots = () => readdirSync(join(campaignDirectory(rootDir), 'snapshots')).sort()
  assert.deepEqual(snapshots(), ['0000000000000000.json', '0000000000000004.json'])
  assert.deepEqual((await store.replay('batched-snapshots', { use_snapshots: false })).state, atFour.state)
  assert.equal((await store.load('batched-snapshots', { atVersion: 3 })).state.hp, 13)

  await commit(4, 1, true)
  assert.equal((await store.load('batched-snapshots')).events_applied, 0)
  await commit(5, 2)
  assert.equal((await store.load('batched-snapshots')).events_applied, 2, 'принудительный снимок начинает новый интервал')
  const last = await commit(7, 1)
  assert.deepEqual(snapshots(), [0, 4, 5, 8].map((version) => `${String(version).padStart(16, '0')}.json`))
  const reopened = new FileEventStore({ rootDir, reducer, snapshotEvery: 3 })
  assert.equal((await reopened.load('batched-snapshots')).events_applied, 0)
  assert.deepEqual((await reopened.replay('batched-snapshots', { use_snapshots: false })).state, last.state)
})

test('snapshotEvery=0 выключает автоматические снимки, но сохраняет явный forceSnapshot', async (t) => {
  const { rootDir, store } = temporaryStore(t, { snapshotEvery: 0 })
  await store.initializeCampaign({ campaign_id: 'manual-snapshots', initial_state: { hp: 10 } })
  await store.commit({
    campaign_id: 'manual-snapshots', expected_state_version: 0, idempotency_key: 'manual', forceSnapshot: true,
    events: [{ event_type: 'HealingApplied', payload: { amount: 1 } }],
  })
  await store.commit({
    campaign_id: 'manual-snapshots', expected_state_version: 1, idempotency_key: 'automatic-disabled',
    events: Array.from({ length: 5 }, () => ({ event_type: 'HealingApplied', payload: { amount: 1 } })),
  })
  assert.deepEqual(readdirSync(join(campaignDirectory(rootDir), 'snapshots')).sort(), ['0000000000000000.json', '0000000000000001.json'])
  const loaded = await store.load('manual-snapshots')
  assert.equal(loaded.events_applied, 5)
  assert.equal(loaded.state.hp, 16)
})

test('новый вызов видит чужой коммит и проверяет журнал даже при готовом снимке', async (t) => {
  const { rootDir, reducer, store } = temporaryStore(t, { snapshotEvery: 1 })
  await store.initializeCampaign({ campaign_id: 'fresh-read', initial_state: { hp: 10 } })
  const request = {
    campaign_id: 'fresh-read', expected_state_version: 0, idempotency_key: 'first',
    events: [{ event_type: 'HealingApplied', payload: { amount: 1 } }],
  }
  await store.commit(request)
  const other = new FileEventStore({ rootDir, reducer, snapshotEvery: 1 })
  await other.commit({ ...request, expected_state_version: 1, idempotency_key: 'second' })
  const duplicate = await store.getByIdempotencyKey('fresh-read', 'first')
  assert.equal(duplicate.state_version, 1)
  assert.equal(duplicate.current_state_version, 2)
  assert.equal(duplicate.state.hp, 11)
  assert.equal((await store.commit(request)).current_state_version, 2)
  const loaded = await store.load('fresh-read', { commits: [], knownCommits: [] })
  assert.equal(loaded.state_version, 2, 'публичные options не подменяют журнал')
  assert.equal(loaded.state.hp, 12)

  const eventsDir = join(campaignDirectory(rootDir), 'events')
  const firstFile = join(eventsDir, readdirSync(eventsDir).sort()[0])
  writeFileSync(firstFile, '{}')
  for (const operation of [
    () => store.load('fresh-read', { commits: [], knownCommits: [] }),
    () => store.getByIdempotencyKey('fresh-read', 'first'),
    () => store.commit({ ...request, expected_state_version: 2, idempotency_key: 'third' }),
  ]) await assert.rejects(operation, { code: 'CORRUPT_EVENT_LOG' })
  assert.equal(readdirSync(eventsDir).length, 2, 'повреждённый журнал не дополняется новым коммитом')
})

test('does not append an event when the injected reducer rejects it', async (t) => {
  const { store } = temporaryStore(t)
  await store.initializeCampaign({ campaign_id: 'reducer-failure', initial_state: { hp: 4 } })

  await assert.rejects(store.commit({
    campaign_id: 'reducer-failure',
    expected_state_version: 0,
    idempotency_key: 'bad-event',
    events: [{ event_type: 'ReducerFailure', payload: {} }],
  }), /reducer rejected event/)

  const loaded = await store.load('reducer-failure')
  assert.equal(loaded.state_version, 0)
  assert.equal(loaded.state.hp, 4)
  assert.deepEqual(await store.getEvents('reducer-failure'), [])
})

test('изменяемый reducer не связывает аргументы, ответы, события и снимки общими ссылками', async (t) => {
  const reducerInputs = []
  const normalizerInputs = []
  const reducer = (state, event) => {
    if (reducerInputs.length) reducerInputs.at(-1).state.stats.hp = -100
    reducerInputs.push({ state, event })
    state.stats.hp += event.payload.amount
    event.payload.amount = 999
    return state
  }
  const normalizeState = (state) => {
    normalizerInputs.push(state)
    state.normalized = true
    return state
  }
  const { rootDir, store } = temporaryStore(t, { reducer, normalizeState, snapshotEvery: 2 })
  const initial = { stats: { hp: 10 } }
  const initialized = await store.initializeCampaign({ campaign_id: 'isolation', initial_state: initial })
  const request = {
    campaign_id: 'isolation', expected_state_version: 0, idempotency_key: 'two-events',
    events: [2, 3].map((amount) => ({ event_type: 'HealingApplied', payload: { amount } })),
  }
  const committed = await store.commit(request)
  const expected = { stats: { hp: 15 }, normalized: true, state_version: 2 }
  assert.deepEqual(committed.state, expected)
  assert.deepEqual(initial, { stats: { hp: 10 } })
  assert.equal(initialized.state.stats.hp, 10)
  assert.deepEqual(committed.events.map((event) => event.payload.amount), [2, 3])
  assert.deepEqual(request.events.map((event) => event.payload.amount), [2, 3])

  for (const { state, event } of reducerInputs) { state.stats.hp = -200; event.payload.amount = -200 }
  for (const state of normalizerInputs) state.stats.hp = -300
  assert.deepEqual(committed.state, expected)
  const duplicate = await store.commit(request)
  assert.equal(duplicate.duplicate, true)
  assert.deepEqual(duplicate.state, expected)
  committed.state.stats.hp = -400
  committed.events[0].payload.amount = -400
  assert.deepEqual((await store.load('isolation')).state, expected)
  assert.deepEqual((await store.replay('isolation', { use_snapshots: false })).state, expected)
  assert.equal((await store.load('isolation', { atVersion: 1 })).state.stats.hp, 12)
  const reopened = new FileEventStore({ rootDir, reducer, normalizeState })
  assert.deepEqual((await reopened.load('isolation')).state, expected)
  assert.deepEqual((await reopened.getEvents('isolation')).map((event) => event.payload.amount), [2, 3])
})

test('ошибка после изменения состояния reducer не сохраняет часть пакета событий', async (t) => {
  const failures = [
    ['throw', /отказ reducer/u],
    ['undefined', { code: 'INVALID_REDUCER_RESULT' }],
    ['promise', { code: 'ASYNC_REDUCER_NOT_SUPPORTED' }],
    ['bigint', { code: 'INVALID_JSON_VALUE' }],
    ['cycle', { code: 'INVALID_JSON_VALUE' }],
  ]
  for (const [failure, expectedError] of failures) {
    await t.test(failure, async (t) => {
      const reducer = (state, event) => {
        state.stats.hp = 0
        if (event.event_type !== 'Failure') return state
        if (failure === 'throw') throw new Error('отказ reducer')
        if (failure === 'undefined') return undefined
        if (failure === 'promise') return Promise.resolve(state)
        if (failure === 'bigint') state.invalid = 1n
        if (failure === 'cycle') state.invalid = state
        return state
      }
      const { store } = temporaryStore(t, { reducer })
      await store.initializeCampaign({ campaign_id: 'atomic', initial_state: { stats: { hp: 10 } } })
      await assert.rejects(store.commit({
        campaign_id: 'atomic', expected_state_version: 0, idempotency_key: 'rejected',
        events: [{ event_type: 'Changed' }, { event_type: 'Failure' }],
      }), expectedError)
      assert.deepEqual((await store.load('atomic')).state, { stats: { hp: 10 }, state_version: 0 })
      assert.deepEqual(await store.getEvents('atomic'), [])
      assert.equal(await store.getByIdempotencyKey('atomic', 'rejected'), null)
    })
  }
})

test('projection outbox survives restart until the compatibility projection acknowledges it', async (t) => {
  const { rootDir, reducer, store } = temporaryStore(t)
  await store.initializeCampaign({ campaign_id: 'projection-recovery', initial_state: { hp: 12 } })
  await store.commit({
    campaign_id: 'projection-recovery',
    expected_state_version: 0,
    idempotency_key: 'projection-turn-1',
    events: [{ event_type: 'DamageApplied', payload: { amount: 3 } }],
  })

  const reopened = new FileEventStore({ rootDir, reducer })
  const pending = await reopened.pendingProjection('projection-recovery')
  assert.equal(pending.checkpoint_version, 0)
  assert.equal(pending.state_version, 1)
  assert.equal(pending.state.hp, 9)
  assert.deepEqual(pending.events.map((event) => event.event_type), ['DamageApplied'])

  await reopened.acknowledgeProjection('projection-recovery', 1)
  assert.equal(await reopened.pendingProjection('projection-recovery'), null)
  assert.equal((await reopened.getMetadata('projection-recovery')).projection_checkpoint_version, 1)
})

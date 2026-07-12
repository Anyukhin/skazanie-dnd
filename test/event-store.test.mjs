import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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

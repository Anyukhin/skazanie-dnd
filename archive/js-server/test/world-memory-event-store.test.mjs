import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileEventStore } from '../server/event-store.mjs'
import { applyWorldMemoryEvent, normalizeWorldMemory } from '../server/world-memory.mjs'
import { normalizeCampaignState, replayEvents } from '../server/rules-engine.mjs'

function entities(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `npc:store-${index}`,
    kind: 'npc',
    name: `Store NPC ${index}`,
    visibility: 'gm_only',
  }))
}

function reduce(state, event) {
  return { ...state, worldMemory: applyWorldMemoryEvent(state.worldMemory, event) }
}

function currentNormalize(state) {
  return { ...state, worldMemory: normalizeWorldMemory(state.worldMemory) }
}

function legacyNormalize(state) {
  const memory = normalizeWorldMemory(state.worldMemory)
  return { ...state, worldMemory: { ...memory, entities: memory.entities.slice(0, 500) } }
}

function campaignDir(rootDir) {
  return join(rootDir, 'campaigns', readdirSync(join(rootDir, 'campaigns'))[0])
}

test('память мира переживает snapshot, reopen, replay и идемпотентный retry', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-world-memory-store-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const initialState = { worldMemory: { entities: entities(500) } }
  const options = { rootDir, reducer: reduce, normalizeState: currentNormalize, snapshotEvery: 1, snapshotProjectorVersion: 2 }
  const store = new FileEventStore(options)
  await store.initializeCampaign({ campaign_id: 'memory-store', initial_state: initialState })
  const request = {
    campaign_id: 'memory-store', expected_state_version: 0, idempotency_key: 'entity-500',
    events: [{ event_type: 'WorldEntityUpserted', payload: { entity: entities(501).at(-1) } }],
  }
  const committed = await store.commit(request)
  assert.equal(committed.state.worldMemory.entities.length, 501)

  const reopened = new FileEventStore(options)
  const loaded = await reopened.load('memory-store')
  const replayed = await reopened.replay('memory-store', { use_snapshots: false })
  assert.equal(loaded.state.worldMemory.entities.length, 501)
  assert.deepEqual(replayed.state, loaded.state)
  const duplicate = await reopened.commit(request)
  assert.equal(duplicate.duplicate, true)
  assert.deepEqual(duplicate.state, loaded.state)
  assert.equal((await reopened.getEvents('memory-store')).length, 1)
})

test('legacy replay сохраняет старую проекцию до commit текущего события', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-world-memory-migration-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const initialState = { worldMemory: { entities: entities(500) } }
  const legacyStore = new FileEventStore({
    rootDir, reducer: reduce, normalizeState: legacyNormalize, snapshotEvery: 1, snapshotProjectorVersion: 1, reducerVersion: 14,
  })
  await legacyStore.initializeCampaign({ campaign_id: 'memory-migration', initial_state: initialState })
  await legacyStore.commit({
    campaign_id: 'memory-migration', expected_state_version: 0, idempotency_key: 'entity-500',
    events: [{ event_type: 'WorldEntityUpserted', payload: { entity: entities(501).at(-1) } }],
  })
  const snapshotFile = join(campaignDir(rootDir), 'snapshots', '0000000000000001.json')
  const oldSnapshotBytes = readFileSync(snapshotFile, 'utf8')
  assert.equal(JSON.parse(oldSnapshotBytes).state.worldMemory.entities.length, 500)

  const currentStore = new FileEventStore({
    rootDir, reducer: reduce, normalizeState: currentNormalize, snapshotEvery: 1, snapshotProjectorVersion: 2,
  })
  const restored = await currentStore.replay('memory-migration')
  const fromEvents = await currentStore.replay('memory-migration', { use_snapshots: false })
  assert.equal(restored.state.worldMemory.entities.length, 500)
  assert.deepEqual(restored.state, fromEvents.state)
  assert.equal(restored.events_applied, 1)
  assert.equal(readFileSync(snapshotFile, 'utf8'), oldSnapshotBytes)

  const currentCommit = await currentStore.commit({
    campaign_id: 'memory-migration', expected_state_version: 1, idempotency_key: 'entity-501',
    events: [{ event_type: 'WorldEntityUpserted', payload: { entity: { id: 'npc:store-500', kind: 'npc', name: 'Store NPC 500', visibility: 'gm_only' } } }],
  })
  assert.equal(currentCommit.state.worldMemory.entities.length, 501)
  const afterRestart = new FileEventStore({
    rootDir, reducer: reduce, normalizeState: currentNormalize, snapshotEvery: 1, snapshotProjectorVersion: 2,
  })
  const currentReplay = await afterRestart.replay('memory-migration')
  const currentFromEvents = await afterRestart.replay('memory-migration', { use_snapshots: false })
  assert.equal(currentReplay.state.worldMemory.entities.length, 501)
  assert.deepEqual(currentReplay.state, currentFromEvents.state)
  assert.equal(currentReplay.reducer_version, 15)
  assert.equal(readFileSync(snapshotFile, 'utf8'), oldSnapshotBytes)
})

test('ошибка пакета памяти не сохраняет частичное изменение мира', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-world-memory-write-failure-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const failingReduce = (state, event) => {
    const next = reduce(state, event)
    if (event.payload?.entity?.id === 'npc:failure') throw new Error('memory reducer rejected event')
    return next
  }
  const store = new FileEventStore({ rootDir, reducer: failingReduce, normalizeState: currentNormalize })
  await store.initializeCampaign({ campaign_id: 'memory-failure', initial_state: { worldMemory: { entities: entities(500) } } })
  await assert.rejects(store.commit({
    campaign_id: 'memory-failure', expected_state_version: 0, idempotency_key: 'failed-memory-batch',
    events: [
      { event_type: 'WorldEntityUpserted', payload: { entity: entities(501).at(-1) } },
      { event_type: 'WorldEntityUpserted', payload: { entity: { id: 'npc:failure', kind: 'npc', name: 'Failure', visibility: 'gm_only' } } },
    ],
  }), /memory reducer rejected event/u)
  const loaded = await store.load('memory-failure')
  assert.equal(loaded.state_version, 0)
  assert.equal(loaded.state.worldMemory.entities.length, 500)
  assert.deepEqual(await store.getEvents('memory-failure'), [])
  assert.equal(await store.getByIdempotencyKey('memory-failure', 'failed-memory-batch'), null)
})

test('direct replay Rules Engine уважает marker retention как FileEventStore', () => {
  const initial = normalizeCampaignState({
    scene: { title: 'Archive', location: 'Archive', cells: [] },
    worldMemory: { entities: entities(500) },
  })
  const oldEvent = {
    event_type: 'WorldEntityUpserted', reducer_version: 14, state_version_after: 1,
    payload: { entity: entities(501).at(-1) },
  }
  const currentEvent = { ...oldEvent, reducer_version: 15 }
  assert.equal(replayEvents(initial, [oldEvent]).worldMemory.entities.length, 500)
  assert.equal(replayEvents(initial, [currentEvent]).worldMemory.entities.length, initial.worldMemory.entities.length + 1)
  const { reducer_version: _marker, ...unmarkedCommittedEvent } = oldEvent
  assert.equal(replayEvents(initial, [unmarkedCommittedEvent]).worldMemory.entities.length, 500)
  const nextCurrentEvent = { ...currentEvent, state_version_after: 2, payload: { entity: entities(502).at(-1) } }
  const mixed = replayEvents(initial, [unmarkedCommittedEvent, nextCurrentEvent])
  assert.equal(mixed.worldMemory.entities.length, initial.worldMemory.entities.length + 1)
  assert.equal(mixed.worldMemory.entities.some((entity) => entity.id === entities(501).at(-1).id), false)
  assert.equal(mixed.worldMemory.entities.some((entity) => entity.id === entities(502).at(-1).id), true)
})

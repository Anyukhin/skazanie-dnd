// Уровень движка: Rules Engine и файловый журнал событий во временном
// каталоге, собранные так же, как их собирает сервер, без HTTP.
//
// Цикл механики из AGENTS.md §6 — команда → правило → событие → reducer —
// проверяется здесь быстрее всего: `resolveCommand` даёт события,
// `applyAll` сворачивает их тем же reducer, `commitEvents` пишет в журнал,
// `assertReplayMatches` сверяет голову журнала с повтором с нуля.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileEventStore } from '../../server/event-store.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../../server/rules-engine.mjs'
import { dice } from './dice.mjs'

/**
 * Свернуть события тем же reducer, что у журнала и сервера.
 *
 * @param {any} state
 * @param {any[]} events
 * @returns {any}
 */
export function applyAll(state, events) {
  return events.reduce((current, event) => applyGameEvent(current, event), state)
}

/**
 * Временный каталог, удаляемый в `t.after`.
 *
 * @param {{ after: (fn: () => unknown) => void }} t
 * @param {string} [prefix]
 * @returns {string}
 */
export function tempDir(t, prefix = 'skazanie-kit-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

/**
 * Журнал событий во временном каталоге, с reducer и нормализацией сервера.
 *
 * `normalize: false` — журнал без `normalizeState`, как в части старых
 * тестов, которые проверяют сырой reducer. Остальные опции уходят в
 * конструктор `FileEventStore` как есть (`snapshotEvery`, `clock`, …).
 *
 * @param {{ after: (fn: () => unknown) => void }} t
 * @param {{ prefix?: string, rootDir?: string, normalize?: boolean } & Record<string, unknown>} [options]
 * @returns {FileEventStore}
 */
export function createTestStore(t, { prefix = 'skazanie-kit-store-', rootDir, normalize = true, ...storeOptions } = {}) {
  return new FileEventStore({
    rootDir: rootDir ?? tempDir(t, prefix),
    reducer: applyGameEvent,
    ...(normalize ? { normalizeState: normalizeCampaignState } : {}),
    ...storeOptions,
  })
}

/**
 * Тот же каталог, новый экземпляр журнала: без кэша головы и прочего
 * состояния в памяти. Так тест имитирует перезапуск сервера.
 *
 * @param {FileEventStore} store
 * @returns {FileEventStore}
 */
export function reopenStore(store) {
  return new FileEventStore({
    rootDir: store.rootDir,
    reducer: store.reducer,
    normalizeState: store.normalizeState,
    initialStateFactory: store.initialStateFactory,
    snapshotEvery: store.snapshotEvery,
    snapshotProjectorVersion: store.snapshotProjectorVersion,
    maxEventsPerCommit: store.maxEventsPerCommit,
    reducerVersion: store.reducerVersion,
    reducerNormalizesInput: store.reducerNormalizesInput,
    mapStore: store.mapStore,
  })
}

/**
 * Журнал во временном каталоге с уже инициализированной кампанией.
 *
 * @param {{ after: (fn: () => unknown) => void }} t
 * @param {string} campaignId
 * @param {any} initialState
 * @param {Parameters<typeof createTestStore>[1]} [options]
 * @returns {Promise<FileEventStore>}
 */
export async function createCampaignStore(t, campaignId, initialState, options = {}) {
  const store = createTestStore(t, options)
  await store.initializeCampaign({ campaign_id: campaignId, initial_state: initialState })
  return store
}

/**
 * Записать события в журнал от текущей головы.
 *
 * @param {FileEventStore} store
 * @param {string} campaignId
 * @param {any[]} events
 * @param {{ idempotencyKey?: string, commandId?: string, expectedStateVersion?: number }} [options]
 */
export async function commitEvents(store, campaignId, events, { idempotencyKey, commandId, expectedStateVersion } = {}) {
  const head = expectedStateVersion ?? (await store.load(campaignId)).current_state_version
  return store.commit({
    campaign_id: campaignId,
    expected_state_version: head,
    idempotency_key: idempotencyKey ?? `kit-commit-${head + 1}`,
    ...(commandId ? { command_id: commandId } : {}),
    events,
  })
}

/**
 * Rules Engine с детерминированными костями.
 *
 * @param {number[] | import('../../server/dice-service.mjs').DiceService} [diceOrValues]
 * @returns {RulesEngine}
 */
export function createEngine(diceOrValues = []) {
  return new RulesEngine({ diceService: Array.isArray(diceOrValues) ? dice(diceOrValues) : diceOrValues })
}

/**
 * Инвариант replay: голова журнала совпадает с повтором с нуля — без
 * снимков, в новом экземпляре журнала на том же каталоге.
 *
 * @param {FileEventStore} store
 * @param {string} campaignId
 * @param {{ expected?: any }} [options] `expected` — состояние, которое тест получил сам (например, через applyAll)
 * @returns {Promise<any>} состояние головы
 */
export async function assertReplayMatches(store, campaignId, { expected } = {}) {
  const head = await store.load(campaignId)
  const replayed = await reopenStore(store).replay(campaignId, { use_snapshots: false })
  assert.equal(replayed.current_state_version, head.current_state_version, 'replay дошёл не до той версии, что голова журнала')
  assert.deepEqual(replayed.state, head.state, 'replay с нуля разошёлся с головой журнала')
  if (expected !== undefined) assert.deepEqual(head.state, expected, 'голова журнала разошлась с ожидаемым состоянием')
  return head.state
}

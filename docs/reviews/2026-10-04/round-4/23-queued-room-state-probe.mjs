import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const source = readFileSync(`${root}/src/useGameSession.ts`, 'utf8')
const hookSource = source.slice(source.indexOf('const ACTIVE_CAMPAIGN_KEY ='))
  .replace('export function useGameSession', 'function useGameSession')
const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-queued-room-state-'))
let compiled
try {
  const sourcePath = join(buildDir, 'hook.ts')
  writeFileSync(sourcePath, hookSource)
  const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const compiledResult = spawnSync(process.execPath, [
    compiler, '--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'ES2022', '--outDir', buildDir, sourcePath,
  ], { encoding: 'utf8' })
  assert.equal(compiledResult.status, 0, compiledResult.stderr || compiledResult.stdout)
  compiled = readFileSync(join(buildDir, 'hook.js'), 'utf8').replace(/export \{\};\s*$/u, '')
} finally {
  rmSync(buildDir, { recursive: true, force: true })
}

function makeStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  }
}

class FakeEventSource {
  static instances = []

  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.closed = false
    FakeEventSource.instances.push(this)
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener)
  }

  removeEventListener(name) {
    this.listeners.delete(name)
  }

  close() {
    this.closed = true
  }

  emit(name, data) {
    this.listeners.get(name)?.({ data })
  }

  open() {
    this.onopen?.()
  }
}

class FakeBroadcastChannel {
  constructor(name) {
    this.name = name
    this.closed = false
  }

  postMessage() {}

  close() {
    this.closed = true
  }
}

function installBrowser() {
  const localStorage = makeStorage()
  const sessionStorage = makeStorage()
  const window = {
    location: { search: '?room=A', href: 'http://localhost/?room=A' },
    history: { replaceState: (_state, _title, url) => { window.location.href = String(url) } },
    localStorage,
    sessionStorage,
    BroadcastChannel: FakeBroadcastChannel,
    EventSource: FakeEventSource,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
  }
  globalThis.window = window
  globalThis.localStorage = localStorage
  globalThis.sessionStorage = sessionStorage
  globalThis.BroadcastChannel = FakeBroadcastChannel
  globalThis.EventSource = FakeEventSource
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
  FakeEventSource.instances.length = 0
}

function makeEmptyState() {
  return {
    sessionCode: 'A',
    campaign: 'Кампания A',
    players: [{ id: 'hero', character: 'Герой', inventory: [], abilities: {}, currency: {} }],
    activePlayerId: 'hero',
    messages: [],
    pendingCheck: null,
    pendingAction: null,
    isNarrating: false,
    state_version: 1,
    scene: null,
    presence: { transport: 'sse', connected_users: 1, connected_heroes: 1, online_hero_ids: [], typing_actor_ids: [] },
  }
}

function makeHarness({ malformed = false } = {}) {
  installBrowser()
  const slots = []
  const effects = []
  let cursor = 0
  const useState = (initial) => {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (value) => {
      slots[index] = typeof value === 'function' ? value(slots[index]) : value
    }]
  }
  const useRef = (initial) => {
    const index = cursor++
    if (!(index in slots)) slots[index] = { current: initial }
    return slots[index]
  }
  const useCallback = (callback) => { cursor += 1; return callback }
  const useEffect = (effect) => { cursor += 1; effects.push(effect) }

  let resolveNarrate
  let rejectNarrate
  let resolveRoomFetch
  const narrateWithAgent = () => {
    if (malformed) return Promise.resolve({})
    return new Promise((resolve, reject) => {
      resolveNarrate = resolve
      rejectNarrate = reject
    })
  }
  const fetchWithTimeout = (...args) => {
    if (String(args[0]).includes('/api/rooms/B')) {
      return new Promise((resolve) => { resolveRoomFetch = resolve })
    }
    return globalThis.fetch(...args)
  }
  class ApiRequestError extends Error {
    constructor(message, status, code) {
      super(message)
      this.status = status
      this.code = code
    }
  }
  const emptyState = makeEmptyState()
  const context = {
    useCallback,
    useEffect,
    useRef,
    useState,
    emptyState,
    ApiRequestError,
    autoRollEnabled: () => false,
    fetchWithTimeout,
    generateItemImage: async () => ({ url: '' }),
    isStateVersionConflictError: () => false,
    narrateWithAgent,
    publishNarrationPreview: () => {},
    rollDice: async () => ({}),
    rollSharedDie: async () => ({}),
    playerMessage: (character, text) => ({ id: `player-${Date.now()}`, speaker: 'player', author: character, text }),
    withLootTakenRecord: (state) => state,
    forgetSceneMaps: () => {},
    latestSceneMapHash: () => '',
    resolveSceneMap: (scene) => scene,
    canIssueUiTacticalCommand: () => true,
    clearPendingTacticalCommand: () => {},
    isTacticalCommandUnknown: () => false,
    pendingTacticalCommandStorageKey: (accountId, campaignId) => `${accountId}:${campaignId}`,
    readPendingTacticalCommand: () => null,
    tacticalCommandRequest: () => ({ init: {} }),
    tacticalCommandView: (value) => value,
    writePendingTacticalCommand: () => {},
    structuredClone,
  }
  const hook = new Function(...Object.keys(context), `${compiled}\nreturn useGameSession`)(...Object.values(context))
  cursor = 0
  const session = hook({ accountId: 'probe-account' })
  const cleanups = effects.map((effect) => effect()).filter((cleanup) => typeof cleanup === 'function')
  return {
    session,
    slots,
    eventSource: FakeEventSource.instances[0],
    effects,
    resolveNarrate: (value) => resolveNarrate?.(value),
    rejectNarrate: (error) => rejectNarrate?.(error),
    resolveRoomFetch: (value) => resolveRoomFetch?.(value),
    cleanups,
  }
}

async function queuedRoomScenario() {
  const harness = makeHarness()
  const pending = harness.session.submitAction('Открыть дверь', 'hero')
  await Promise.resolve()
  assert.equal(harness.slots[0].isNarrating, true, 'submitAction должен перейти в ожидание ответа')
  harness.eventSource.emit('room', JSON.stringify({
    version: 7,
    state: { ...makeEmptyState(), state_version: 7, sessionCode: 'A' },
  }))
  const switching = harness.session.switchCampaign('B')
  await Promise.resolve()
  harness.resolveRoomFetch({
    ok: true,
    json: async () => ({
      version: 1,
      state: { ...makeEmptyState(), sessionCode: 'B', campaign: 'Кампания B', state_version: 1 },
    }),
  })
  await switching
  assert.equal(harness.slots[0].sessionCode, 'B', 'switchCampaign должен применить загруженную B')
  // React перезапустит этот реальный effect после applyRemote(B): state.isNarrating
  // изменился с optimistic true на server false. Вызываем тело effect вручную,
  // потому что harness не добавляет React scheduler и DOM.
  const flushEffect = harness.effects.find((effect) => effect.toString().includes('if (!busy.current') && effect.toString().includes('flushQueuedRooms'))
  assert.equal(typeof flushEffect, 'function', 'должен быть effect, который сбрасывает очередь')
  flushEffect()
  const afterFlush = harness.slots[0].sessionCode
  const persistedCampaign = globalThis.localStorage.getItem('skazanie-active-campaign-v2')
  const urlCampaign = new URL(globalThis.window.location.href).searchParams.get('room')
  harness.resolveNarrate({ narration: 'Поздний ответ', effects: { grantItems: [] }, turn_consumed: false })
  const result = await pending
  for (const cleanup of harness.cleanups) cleanup()
  assert.equal(afterFlush, 'A')
  assert.equal(persistedCampaign, 'A')
  assert.equal(urlCampaign, 'B')
  assert.equal(result.ok, false)
  return { before_flush: 'B', after_flush: afterFlush, queued_version: 7, current_room_version: 1, persisted_campaign: persistedCampaign, url_campaign: urlCampaign }
}

async function malformedResponseScenario() {
  const harness = makeHarness({ malformed: true })
  const first = harness.session.submitAction('Осмотреться', 'hero')
  const rejection = await first.then(() => null, (error) => String(error?.message ?? error))
  const second = await harness.session.submitAction('Повторить', 'hero')
  for (const cleanup of harness.cleanups) cleanup()
  assert.match(rejection, /narration|trim|undefined/i)
  assert.equal(harness.slots[0].isNarrating, true)
  assert.deepEqual(second, { ok: false, error: 'Сейчас нельзя отправить это действие.' })
  return { first_rejection: rejection, is_narrating_after_rejection: harness.slots[0].isNarrating, second_submit: second }
}

const result = {
  ok: true,
  scenarios: {
    queued_snapshot_applied_after_switch: await queuedRoomScenario(),
    malformed_200_leaves_busy_path: await malformedResponseScenario(),
  },
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

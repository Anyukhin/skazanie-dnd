import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { Session } from 'node:inspector'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

// Фикстура загружает dotenv/config. Пустой файл исключает случайное чтение
// рабочего .env и использование ключа модели во время измерения.
const sandbox = mkdtempSync(join(tmpdir(), 'skazanie-large-campaign-performance-'))
const emptyEnv = join(sandbox, 'empty.env')
writeFileSync(emptyEnv, '', 'utf8')
process.env.DOTENV_CONFIG_PATH = emptyEnv
process.env.ROUTERAI_API_KEY = ''

const fixture = await import('./world-data-measurements.mjs')
const { DEFAULT_COUNTS, countMemory, measureProductionStorage } = fixture
const { FileEventStore } = await import('../server/event-store.mjs')
const { GAME_STATE_PROJECTOR_VERSION, applyGameEvent, normalizeCampaignState } = await import('../server/rules-engine.mjs')

const CAMPAIGN_ID = 'world-data-measurement'
const BASE_TAIL_EVENTS = 10
const FIXED_CLOCK = () => new Date('2026-09-16T00:00:00.000Z')
const clone = (value) => structuredClone(value)

function summaryStats(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = (fraction) => sorted.length
    ? Number(sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)].toFixed(3))
    : 0
  return {
    count: values.length,
    min_ms: values.length ? Number(Math.min(...values).toFixed(3)) : 0,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    max_ms: Number(Math.max(...values, 0).toFixed(3)),
    mean_ms: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)) : 0,
  }
}

function timed(operation) {
  const started = performance.now()
  const value = operation()
  return { value, elapsedMs: performance.now() - started }
}

async function timedAsync(operation) {
  const started = performance.now()
  const value = await operation()
  return { value, elapsedMs: performance.now() - started }
}

function campaignDirectory(rootDir) {
  const campaigns = join(rootDir, 'campaigns')
  const names = existsSync(campaigns) ? readdirSync(campaigns) : []
  assert.equal(names.length, 1, 'Fixture must contain exactly one campaign')
  return join(campaigns, names[0])
}

function initialStateFromFixture(rootDir) {
  const file = join(campaignDirectory(rootDir), 'snapshots', '0000000000000000.json')
  return JSON.parse(readFileSync(file, 'utf8')).state
}

function tailEvents(label, count = BASE_TAIL_EVENTS) {
  return Array.from({ length: count }, (_, offset) => {
    const number = offset + 1
    return {
      event_id: `performance-${label}-event-${number}`,
      event_type: 'WorldFactRecorded',
      actor_id: null,
      target_ids: [],
      source_rule_ids: [],
      payload: {
        fact: {
          id: `fact:performance-${label}-${number}`,
          subject_id: 'npc:measurement-1',
          predicate: 'records_performance_tail',
          object: `Синтетическая запись профиля ${label}, событие ${number}.`,
          summary: `Профиль ${label}, событие ${number}.`,
          visibility: 'party',
          source_event_ids: [`performance-source-${label}-${number}`],
          source_command_id: `performance-command-${label}-${number}`,
          recorded_at_minutes: number,
        },
      },
    }
  })
}

function newStore(rootDir, initialState, snapshotEvery) {
  let idSequence = 0
  return new FileEventStore({
    rootDir,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    initialStateFactory: () => clone(initialState),
    reducerNormalizesInput: true,
    snapshotEvery,
    maxEventsPerCommit: BASE_TAIL_EVENTS,
    clock: FIXED_CLOCK,
    idFactory: () => `performance-id-${String(++idSequence).padStart(8, '0')}`,
  })
}

async function measureJournalRead() {
  const templateRoot = join(sandbox, 'journal-template')
  const templateStore = newStore(templateRoot, smallState(), 0)
  await templateStore.initializeCampaign({ campaignId: 'JOURNAL', initialState: smallState() })
  await templateStore.commit({
    campaignId: 'JOURNAL', expectedStateVersion: 0, idempotencyKey: 'journal-template', commandId: 'journal-template',
    events: [{ event_id: 'journal-template-event', event_type: 'CampaignActivated', actor_id: 'hero', target_ids: [], source_rule_ids: [], payload: { changed_by: 'performance-harness' } }],
  })
  const templatePath = join(templateStore._layout('JOURNAL').events, readdirSync(templateStore._layout('JOURNAL').events)[0])
  const template = JSON.parse(readFileSync(templatePath, 'utf8'))
  const counts = [1, 100, 500]
  const measurements = []
  for (const fileCount of counts) {
    const rootDir = join(sandbox, `journal-${fileCount}`)
    const store = newStore(rootDir, smallState(), 0)
    const layout = store._layout('JOURNAL')
    const eventsDir = layout.events
    mkdirSync(eventsDir, { recursive: true })
    for (let index = 1; index <= fileCount; index += 1) {
      const commit = clone(template)
      const event = clone(template.events[0])
      const start = index
      const end = index
      const id = `journal-${String(index).padStart(6, '0')}`
      event.event_id = `${id}-event`
      event.command_id = id
      event.idempotency_key = id
      event.state_version_before = start - 1
      event.state_version_after = end
      event.campaign_id = 'JOURNAL'
      commit.commit_id = id
      commit.command_id = id
      commit.idempotency_key = id
      commit.state_version_before = start - 1
      commit.state_version_after = end
      commit.events = [event]
      commit.campaign_id = 'JOURNAL'
      writeFileSync(join(eventsDir, `${String(start).padStart(16, '0')}-${String(end).padStart(16, '0')}-${id}.json`), `${JSON.stringify(commit)}\n`, 'utf8')
    }
    const measured = timed(() => store._readCommits(layout))
    assert.equal(measured.value.length, fileCount, `journal read count ${fileCount}`)
    measurements.push({ log_files: fileCount, commits: measured.value.length, bytes: measured.value.reduce((sum, commit) => sum + Buffer.byteLength(JSON.stringify(commit), 'utf8'), 0), elapsed_ms: Number(measured.elapsedMs.toFixed(3)) })
    rmSync(rootDir, { recursive: true, force: true })
  }
  rmSync(templateRoot, { recursive: true, force: true })
  return {
    definition: 'isolated FileEventStore._readCommits validation over synthetic contiguous commit files; no replay or reducer application',
    measurements,
    cache_freshness: 'Each call uses a new FileEventStore and reads the directory from disk; no process cache is used or introduced.',
  }
}

function smallState({ code = 'PERF-SMALL', actorId = 'hero' } = {}) {
  return normalizeCampaignState({
    sessionCode: code, campaign: 'Малая синтетическая кампания', activePlayerId: actorId, partyMemberIds: [actorId], state_version: 0,
    players: [
      { id: actorId, character: 'Герой', hp: 10, maxHp: 10, armor: 14, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, proficiency: 2, inventory: [], online: true, x: 0, y: 0 },
      { id: 'goblin', character: 'Гоблин', hp: 8, maxHp: 8, armor: 12, abilities: { str: 8, dex: 14, con: 10, int: 8, wis: 8, cha: 8 }, proficiency: 2, inventory: [], online: true },
    ],
    messages: [], scene: { title: 'Зал', location: 'Стенд', mood: '', objective: '', turn: 0, cells: [
      { x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'floor', revealed: true }, { x: 2, y: 0, type: 'floor', revealed: true },
    ] },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce',
  })
}

async function measureMixed(baseRoot, initialState) {
  const largeRoot = `${baseRoot}-mixed-large`
  const smallRoot = `${baseRoot}-mixed-small`
  cpSync(baseRoot, largeRoot, { recursive: true })
  try {
    const smallInitial = smallState()
    const largeStore = newStore(largeRoot, initialState, 0)
    const smallStore = newStore(smallRoot, smallInitial, 0)
    await smallStore.initializeCampaign({ campaignId: CAMPAIGN_ID, initialState: smallInitial })
    const delay = monitorEventLoopDelay({ resolution: 10 })
    delay.enable()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    delay.reset()
    const largeStart = performance.now()
    const smallStart = performance.now()
    const schedule = (operation, started) => new Promise((resolvePromise, reject) => {
      setImmediate(() => {
        const invoked = performance.now()
        operation().then((value) => resolvePromise({
          value, elapsed_ms: performance.now() - started,
          queue_delay_ms: invoked - started, operation_elapsed_ms: performance.now() - invoked,
        }), reject)
      })
    })
    const [large, small] = await Promise.all([
      schedule(() => largeStore.commit({
        campaignId: CAMPAIGN_ID, expectedStateVersion: BASE_TAIL_EVENTS, idempotencyKey: 'performance:mixed:large', commandId: 'performance:mixed:large', events: tailEvents('mixed-large'),
      }), largeStart),
      schedule(() => smallStore.commit({
        campaignId: CAMPAIGN_ID, expectedStateVersion: 0, idempotencyKey: 'performance:mixed:small', commandId: 'performance:mixed:small', events: [{
          event_id: 'performance-mixed-small-event', event_type: 'CampaignActivated', actor_id: 'hero', target_ids: [], source_rule_ids: [], payload: { changed_by: 'performance-harness' },
        }],
      }), smallStart),
    ])
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    delay.disable()
    const histogram = delay.count > 0
      ? { min: Number((delay.min / 1e6).toFixed(3)), mean: Number((delay.mean / 1e6).toFixed(3)), p50: Number((delay.percentile(50) / 1e6).toFixed(3)), p95: Number((delay.percentile(95) / 1e6).toFixed(3)), max: Number((delay.max / 1e6).toFixed(3)) }
      : { min: 0, mean: 0, p50: 0, p95: 0, max: 0 }
    return {
      definition: 'large production commit and one ordinary small production commit scheduled in the same event loop turn',
      large_elapsed_ms: Number(large.elapsed_ms.toFixed(3)), small_elapsed_ms: Number(small.elapsed_ms.toFixed(3)),
      large_queue_delay_ms: Number(large.queue_delay_ms.toFixed(3)), small_queue_delay_ms: Number(small.queue_delay_ms.toFixed(3)),
      large_operation_ms: Number(large.operation_elapsed_ms.toFixed(3)), small_operation_ms: Number(small.operation_elapsed_ms.toFixed(3)),
      event_loop_delay_samples: delay.count, event_loop_delay_ms: histogram,
      state_versions: { large: large.value.state_version, small: small.value.state_version },
    }
  } finally {
    rmSync(largeRoot, { recursive: true, force: true })
    rmSync(smallRoot, { recursive: true, force: true })
  }
}

async function requestJson(url, options = {}) {
  const started = performance.now()
  const requestOptions = { ...options }
  if (requestOptions.body && typeof requestOptions.body !== 'string') requestOptions.body = JSON.stringify(requestOptions.body)
  const response = await fetch(url, requestOptions)
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 500) } }
  return { status: response.status, body, elapsed_ms: Number((performance.now() - started).toFixed(3)), response_bytes: Buffer.byteLength(text, 'utf8'), headers: response.headers }
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`HTTP server exited with ${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* startup */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error('HTTP server did not become healthy')
}

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolvePromise, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolvePromise, reject) => probe.close((error) => error ? reject(error) : resolvePromise()))
  return port
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP server did not stop')), 5_000)
    child.once('exit', () => { clearTimeout(timer); resolvePromise() })
    child.kill()
  })
}

async function measureEndpoint(initialState, reps = 15) {
  const storage = join(sandbox, 'endpoint-storage')
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const started = performance.now()
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', DOTENV_CONFIG_PATH: emptyEnv, ADMIN_SETUP_TOKEN: 'performance-setup-token',
      GAME_ENGINE_MODE: 'enforce', COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (chunk) => { logs += String(chunk).slice(-2_000) })
  child.stderr.on('data', (chunk) => { logs += String(chunk).slice(-2_000) })
  try {
    await waitForHealth(baseUrl, child)
    const startupMs = performance.now() - started
    const setup = await requestJson(`${baseUrl}/api/auth/setup-admin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Performance Admin', email: 'performance@example.test', password: 'performance-password', setupToken: 'performance-setup-token' }),
    })
    assert.equal(setup.status, 201, logs)
    const cookie = setup.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, 'HTTP setup did not return a session cookie')
    const headers = { 'Content-Type': 'application/json', Cookie: cookie }
    const registered = await requestJson(`${baseUrl}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Performance Player', email: 'performance-player@example.test', password: 'performance-player-password' }),
    })
    assert.equal(registered.status, 201, JSON.stringify(registered.body))
    const playerCookie = registered.headers.get('set-cookie')?.split(';')[0]
    assert.ok(playerCookie, 'HTTP register did not return a player session cookie')
    const playerHeaders = { 'Content-Type': 'application/json', Cookie: playerCookie }
    const small = smallState({ code: 'PERF-SMALL', actorId: 'hero' })
    const expanded = { ...smallState({ code: 'PERF-LARGE', actorId: 'hero-1' }), worldMemory: clone(initialState.worldMemory) }
    for (const [code, state] of [['PERF-SMALL', small], ['PERF-LARGE', smallState({ code: 'PERF-LARGE', actorId: 'hero-1' })]]) {
      const campaign = await requestJson(`${baseUrl}/api/campaigns`, {
        method: 'POST', headers, body: JSON.stringify({ code, name: `HTTP стенд ${code}`, state }),
      })
      assert.equal(campaign.status, 201, `${code}: ${JSON.stringify(campaign.body)}`)
    }
    const users = await requestJson(`${baseUrl}/api/admin/users`, { headers: { Cookie: cookie } })
    assert.equal(users.status, 200, JSON.stringify(users.body))
    const player = users.body.users.find((candidate) => candidate.email === 'performance-player@example.test')
    assert.ok(player, 'HTTP player was not listed by admin')
    const assigned = await requestJson(`${baseUrl}/api/admin/users/${player.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ heroIds: ['hero', 'hero-1'] }),
    })
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body))
    // Лимит HTTP-тела не меняется: создаём обе кампании обычным маршрутом,
    // затем расширяем большую через штатное хранилище воспроизводимым
    // событием импорта. Всё хранилище этого процесса временное.
    const eventRoot = join(storage, 'engine')
    const expansionStore = new FileEventStore({
      rootDir: eventRoot,
      reducer: applyGameEvent,
      normalizeState: normalizeCampaignState,
      reducerNormalizesInput: true,
      snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
    })
    await expansionStore.commit({
      campaignId: 'PERF-LARGE', expectedStateVersion: 0,
      idempotencyKey: 'performance-http-expand', commandId: 'performance-http-expand',
      events: [{ event_id: 'performance-http-expand-event', event_type: 'LegacyStateImported', actor_id: null, target_ids: [], source_rule_ids: [], payload: { state: expanded, source: 'performance-harness' } }],
    })
    await expansionStore.createSnapshot('PERF-LARGE')

    const moveSeries = async (code, actorId) => {
      const measurements = []
      let lastCommand = null
      for (let index = 1; index <= reps; index += 1) {
        const destination = index % 2 === 1 ? { x: 2, y: 0 } : { x: 0, y: 0 }
        lastCommand = {
          idempotency_key: `performance-http-${code}-${index}`,
          message: `HTTP movement ${code} ${index}`,
          command: { command_type: 'MoveActor', actor_id: actorId, to: destination },
        }
        const result = await requestJson(`${baseUrl}/api/campaigns/${code}/commands`, { method: 'POST', headers: playerHeaders, body: JSON.stringify(lastCommand) })
        assert.equal(result.status, 200, `${code} move ${index}: ${JSON.stringify(result.body)}`)
        const actor = result.body.authoritative_state?.players?.find((candidate) => String(candidate.id) === actorId)
        assert.deepEqual({ x: actor?.x, y: actor?.y }, destination, `${code} move ${index} did not reach its destination`)
        assert.equal(result.body.authoritative_state?.mechanics?.combat?.active, false, `${code} move ${index} unexpectedly entered combat`)
        measurements.push({ index, elapsed_ms: result.elapsed_ms, response_bytes: result.response_bytes, status: result.status, state_version: result.body.authoritative_state?.state_version ?? result.body.state_version ?? null, room_version: result.body.room_version ?? null })
      }
      const duplicate = await requestJson(`${baseUrl}/api/campaigns/${code}/commands`, { method: 'POST', headers: playerHeaders, body: lastCommand })
      assert.equal(duplicate.status, 200, `${code} duplicate: ${JSON.stringify(duplicate.body)}`)
      assert.equal(duplicate.body.idempotent_replay, true, `${code} duplicate was not marked idempotent`)
      return { summary: summaryStats(measurements.map((item) => item.elapsed_ms)), measurements, duplicate: { elapsed_ms: duplicate.elapsed_ms, response_bytes: duplicate.response_bytes, status: duplicate.status, replayed: true } }
    }
    const series = { small: await moveSeries('PERF-SMALL', 'hero'), expanded: await moveSeries('PERF-LARGE', 'hero-1') }
    const smallLoaded = await expansionStore.load('PERF-SMALL')
    const expandedLoaded = await expansionStore.load('PERF-LARGE')
    for (const collection of Object.keys(DEFAULT_COUNTS)) {
      const retained = new Set((expandedLoaded.state.worldMemory[collection] ?? []).map((entry) => entry.id))
      assert.ok((initialState.worldMemory[collection] ?? []).every((entry) => retained.has(entry.id)), `${collection}: HTTP lost stored records`)
    }
    return {
      startup_ms: Number(startupMs.toFixed(3)), no_llm: true, reps,
      fixture: 'minimal HTTP payload for both campaigns; PERF-LARGE expanded by a LegacyStateImported event through FileEventStore and a snapshot with the production projector version before movement',
      snapshot_projector_version: GAME_STATE_PROJECTOR_VERSION,
      world_size: {
        small: { counts: countMemory(smallLoaded.state.worldMemory), state_bytes: Buffer.byteLength(JSON.stringify(smallLoaded.state), 'utf8') },
        expanded: { counts: countMemory(expandedLoaded.state.worldMemory), state_bytes: Buffer.byteLength(JSON.stringify(expandedLoaded.state), 'utf8') },
        exact: true,
      },
      series,
    }
  } finally {
    await stopChild(child)
  }
}

function instrumentStore(store) {
  const counters = { calls: {}, elapsed_ms: {}, events_applied: 0, commits_read: 0, snapshots_read: 0, snapshots_written: 0 }
  const record = (name, elapsedMs) => {
    counters.calls[name] = (counters.calls[name] ?? 0) + 1
    counters.elapsed_ms[name] = (counters.elapsed_ms[name] ?? 0) + elapsedMs
  }
  const wrap = (name) => {
    const original = store[name]
    assert.equal(typeof original, 'function', `Missing FileEventStore method ${name}`)
    store[name] = function wrappedStoreMethod(...args) {
      const started = performance.now()
      try {
        const value = original.apply(this, args)
        if (name === '_applyEvent') counters.events_applied += 1
        if (name === '_readCommits') counters.commits_read += Array.isArray(value) ? value.length : 0
        if (name === '_readSnapshot' && value) counters.snapshots_read += 1
        if (name === '_writeSnapshot') counters.snapshots_written += 1
        return value
      } finally {
        record(name, performance.now() - started)
      }
    }
  }
  const originalReducer = store.reducer
  store.reducer = function instrumentedReducer(...args) {
    const started = performance.now()
    try { return originalReducer(...args) }
    finally { record('reducer', performance.now() - started) }
  }
  const originalNormalize = store.normalizeState
  store.normalizeState = function instrumentedNormalize(...args) {
    const started = performance.now()
    try { return originalNormalize(...args) }
    finally { record('full_normalize', performance.now() - started) }
  }
  for (const name of ['_readCommits', '_readSnapshot', '_load', '_applyEvents', '_applyEvent', '_normalizeState', '_writeSnapshot', '_commitFile', '_writeMetadata']) {
    if (typeof store[name] === 'function') wrap(name)
  }
  return {
    reset() {
      counters.calls = {}
      counters.elapsed_ms = {}
      counters.events_applied = 0
      counters.commits_read = 0
      counters.snapshots_read = 0
      counters.snapshots_written = 0
    },
    snapshot() {
      const stateNormalizeCalls = counters.calls._normalizeState ?? 0
      return {
        ...clone(counters),
        full_normalize_calls: counters.calls.full_normalize ?? 0,
        full_normalize_ms: Number((counters.elapsed_ms.full_normalize ?? 0).toFixed(3)),
        store_full_normalize_calls: counters.calls.full_normalize ?? 0,
        store_full_normalize_ms: Number((counters.elapsed_ms.full_normalize ?? 0).toFixed(3)),
        normalize_scope: 'FileEventStore.normalizeState wrapper only; internal Rules Engine normalizers are not counted',
        state_copy_units_estimate: stateNormalizeCalls * 2 + counters.events_applied,
      }
    },
  }
}

function profileSummary(profile) {
  const nodes = new Map((profile?.nodes ?? []).map((node) => [node.id, node]))
  const samples = Array.isArray(profile?.samples) ? profile.samples : []
  const deltas = Array.isArray(profile?.timeDeltas) ? profile.timeDeltas : []
  const totalUs = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) : samples.length
  const rows = new Map()
  for (let index = 0; index < samples.length; index += 1) {
    const frame = nodes.get(samples[index])?.callFrame ?? {}
    const functionName = frame.functionName || '(anonymous)'
    const url = frame.url || ''
    const key = `${functionName}\t${url}`
    rows.set(key, (rows.get(key) ?? 0) + (deltas[index] ?? 1))
  }
  const top = [...rows].sort((left, right) => right[1] - left[1]).slice(0, 30).map(([key, selfUs]) => {
    const [functionName, url] = key.split('\t')
    return { function: functionName, url, self_us: selfUs, self_percent: Number((selfUs / Math.max(1, totalUs) * 100).toFixed(2)) }
  })
  const worldMemoryUs = [...rows].reduce((sum, [key, value]) => sum + (key.includes('/server/world-memory.mjs') ? value : 0), 0)
  const indexKnowledgeUs = [...rows].filter(([key]) => key.startsWith('indexKnowledge\t')).reduce((sum, [, value]) => sum + value, 0)
  return {
    samples: samples.length,
    sampled_cpu_us: totalUs,
    indexKnowledge_cpu_us: indexKnowledgeUs,
    indexKnowledge_cpu_percent: Number((indexKnowledgeUs / Math.max(1, totalUs) * 100).toFixed(2)),
    world_memory_cpu_us: worldMemoryUs,
    world_memory_cpu_percent: Number((worldMemoryUs / Math.max(1, totalUs) * 100).toFixed(2)),
    top,
  }
}

function inspectorPost(session, method, params = {}) {
  return new Promise((resolvePromise, reject) => {
    session.post(method, params, (error, result) => error ? reject(error) : resolvePromise(result))
  })
}

async function captureCpu(operation, outputPath = null) {
  const session = new Session()
  session.connect()
  let value
  let operationError
  let profile
  try {
    await inspectorPost(session, 'Profiler.enable')
    await inspectorPost(session, 'Profiler.start')
    try { value = await operation() }
    catch (error) { operationError = error }
    profile = (await inspectorPost(session, 'Profiler.stop')).profile
  } finally {
    try { await inspectorPost(session, 'Profiler.disable') } catch { /* best effort */ }
    session.disconnect()
  }
  if (outputPath) writeFileSync(resolve(outputPath), `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  if (operationError) throw operationError
  return { value, summary: profileSummary(profile) }
}

async function countStateTransfers(operation, counters) {
  const original = { stringify: JSON.stringify, parse: JSON.parse, clone: globalThis.structuredClone }
  const observe = (kind, value) => {
    const state = value?.worldMemory ? value : value?.state?.worldMemory ? value.state : null
    if (!state) return
    counters[kind] = (counters[kind] ?? 0) + 1
  }
  JSON.stringify = function (value, ...args) { observe('json_serializations', value); return original.stringify.call(JSON, value, ...args) }
  JSON.parse = function (...args) { const value = original.parse.apply(JSON, args); observe('json_parses', value); return value }
  globalThis.structuredClone = function (value, ...args) { observe('structured_clones', value); return original.clone(value, ...args) }
  try { return await operation() }
  finally {
    JSON.stringify = original.stringify
    JSON.parse = original.parse
    globalThis.structuredClone = original.clone
  }
}

async function profileRepresentative(baseRoot, initialState, profileOutput) {
  const rootDir = `${baseRoot}-cpu`
  cpSync(baseRoot, rootDir, { recursive: true })
  try {
    const store = newStore(rootDir, initialState, 0)
    const instrumentation = instrumentStore(store)
    const events = tailEvents('cpu')
    const stateTransfers = { scope: 'global JSON/structuredClone boundaries containing worldMemory; CPU probe only, outside latency series' }
    const captured = await captureCpu(() => countStateTransfers(() => store.commit({
      campaignId: CAMPAIGN_ID, expectedStateVersion: BASE_TAIL_EVENTS,
      idempotencyKey: 'performance:cpu', commandId: 'performance:cpu-command', events,
    }), stateTransfers), profileOutput)
    return { ...captured.summary, counters: instrumentation.snapshot(), state_transfers: stateTransfers }
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
}

async function runCase(baseRoot, initialState, expectedCounts, kind, reps) {
  const snapshotEvery = kind === 'snapshot_commit' ? BASE_TAIL_EVENTS : 0
  const measurements = []
  for (let repeat = 1; repeat <= reps; repeat += 1) {
    const rootDir = `${baseRoot}-${kind}-${repeat}`
    cpSync(baseRoot, rootDir, { recursive: true })
    try {
      const store = newStore(rootDir, initialState, snapshotEvery)
      const instrumentation = instrumentStore(store)
      const events = tailEvents(`${kind}-${repeat}`)
      let first = null
      if (kind === 'warm_commit') {
        await store.load(CAMPAIGN_ID)
        instrumentation.reset()
      }
      if (kind === 'idempotent_replay') {
        first = await store.commit({
          campaignId: CAMPAIGN_ID, expectedStateVersion: BASE_TAIL_EVENTS,
          idempotencyKey: `performance:idempotent:${repeat}`, commandId: `performance:idempotent-command:${repeat}`, events,
        })
        instrumentation.reset()
      }
      const idempotencyKey = kind === 'idempotent_replay' ? `performance:idempotent:${repeat}` : `performance:${kind}:${repeat}`
      const command = {
        campaignId: CAMPAIGN_ID, expectedStateVersion: BASE_TAIL_EVENTS,
        idempotencyKey, commandId: kind === 'idempotent_replay' ? `performance:idempotent-command:${repeat}` : `performance:${kind}-command:${repeat}`, events,
      }
      const measured = await timedAsync(() => store.commit(command))
      const counters = instrumentation.snapshot()
      const response = timed(() => JSON.stringify(measured.value))
      const normalized = timed(() => normalizeCampaignState(measured.value.state))
      const loaded = await store.load(CAMPAIGN_ID)
      const expectedVersion = BASE_TAIL_EVENTS + BASE_TAIL_EVENTS
      assert.equal(loaded.state_version, expectedVersion, `${kind}: unexpected state version`)
      assert.equal(countMemory(loaded.state.worldMemory).facts, expectedCounts.facts + BASE_TAIL_EVENTS * 2, `${kind}: fact retention changed`)
      measurements.push({
        repeat, elapsed_ms: Number(measured.elapsedMs.toFixed(3)), response_ms: Number(response.elapsedMs.toFixed(3)), response_bytes: Buffer.byteLength(response.value, 'utf8'),
        full_normalize_ms_outside_store: Number(normalized.elapsedMs.toFixed(3)), state_version: measured.value.state_version,
        stages: {
          prepare_command_ms: null,
          load_ms: Number((counters.elapsed_ms._load ?? 0).toFixed(3)),
          apply_events_ms: Number((counters.elapsed_ms._applyEvents ?? counters.elapsed_ms._applyEvent ?? 0).toFixed(3)),
          store_normalize_ms: counters.store_full_normalize_ms,
          commit_write_ms: Number(((counters.elapsed_ms._commitFile ?? 0) + (counters.elapsed_ms._writeSnapshot ?? 0) + (counters.elapsed_ms._writeMetadata ?? 0)).toFixed(3)),
          response_serialize_ms: Number(response.elapsedMs.toFixed(3)),
        },
        record_counts: countMemory(loaded.state.worldMemory),
        replayed: Boolean(measured.value.duplicate), counters,
        ...(first ? { first_commit_state_version: first.state_version } : {}),
      })
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  }
  return { kind, definition: kind === 'warm_commit' ? 'load once before timed commit' : kind === 'snapshot_commit' ? 'snapshotEvery=10 writes a snapshot during the timed commit' : kind === 'idempotent_replay' ? 'duplicate commit with the same idempotency key' : 'new store, no pre-load, snapshotEvery=0', summary: summaryStats(measurements.map((item) => item.elapsed_ms)), measurements }
}

function parseArgs(argv) {
  const options = { reps: 1, endpointReps: 15, scale: 1, mixed: false, endpoint: false }
  for (const arg of argv) {
    if (arg.startsWith('--reps=')) options.reps = Math.max(1, Math.min(20, Number(arg.slice('--reps='.length)) || 1))
    else if (arg.startsWith('--endpoint-reps=')) options.endpointReps = Math.max(15, Math.min(20, Number(arg.slice('--endpoint-reps='.length)) || 15))
    else if (arg.startsWith('--scale=')) options.scale = Math.max(0.001, Number(arg.slice('--scale='.length)) || 1)
    else if (arg.startsWith('--profile-output=')) options.profileOutput = arg.slice('--profile-output='.length)
    else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length)
    else if (arg === '--mixed') options.mixed = true
    else if (arg === '--endpoint') options.endpoint = true
    else if (arg === '--endpoint-only') { options.endpoint = true; options.endpointOnly = true }
  }
  return options
}

async function main() {
  const benchmarkStarted = performance.now()
  const options = parseArgs(process.argv.slice(2))
  const counts = Object.fromEntries(Object.entries(DEFAULT_COUNTS).map(([key, value]) => [key, Math.max(1, Math.round(value * options.scale))]))
  const baseRoot = join(sandbox, 'fixture')
  const seedStarted = performance.now()
  const seed = await measureProductionStorage({ counts, productionRootDir: baseRoot, keepStorage: true, productionTail: BASE_TAIL_EVENTS, snapshotEvery: BASE_TAIL_EVENTS })
  const seedElapsedMs = performance.now() - seedStarted
  const initialState = initialStateFromFixture(baseRoot)
  const profile = options.endpointOnly ? null : await profileRepresentative(baseRoot, initialState, options.profileOutput)
  const journalRead = options.endpointOnly ? null : await measureJournalRead()
  const cases = []
  if (!options.endpointOnly) for (const kind of ['cold_commit', 'warm_commit', 'snapshot_commit', 'idempotent_replay']) cases.push(await runCase(baseRoot, initialState, counts, kind, options.reps))
  const mixed = options.mixed ? await measureMixed(baseRoot, initialState) : null
  const endpoint = options.endpoint ? await measureEndpoint(initialState, options.endpointReps) : null
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    fixture_clock: FIXED_CLOCK().toISOString(),
    command: process.argv.slice(2),
    total_elapsed_ms: Number((performance.now() - benchmarkStarted).toFixed(3)),
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu_count: (await import('node:os')).cpus().length, no_llm: true, storage: 'temporary' },
    fixture: { counts, base_tail_events: BASE_TAIL_EVENTS, state_version_before_benchmark: BASE_TAIL_EVENTS, state_bytes: Buffer.byteLength(JSON.stringify(initialState), 'utf8'), source: 'eval/world-data-measurements.mjs:measureProductionStorage' },
    seed: { elapsed_ms: Number(seedElapsedMs.toFixed(3)), timings: seed.timings, retention: seed.retention, replay_identical: seed.replay_identical, snapshot_replay_identical: seed.snapshot_replay_identical },
    cpu_profile: profile,
    journal_read: journalRead,
    cases,
    ...(mixed ? { mixed } : {}),
    ...(endpoint ? { endpoint } : {}),
    limitations: [
      'Профиль CPU захватывает один production FileEventStore.commit для 10 событий; sampled self CPU не является wall time.',
      'Warm означает предварительный load в том же процессе; FileEventStore не имеет общего кэша состояния.',
      'cases измеряет persistence/reducer без подготовки команды; endpoint отдельно измеряет реальный HTTP без LLM, без подключённого SSE-клиента.',
    ],
  }
  if (options.output) writeFileSync(resolve(options.output), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  rmSync(sandbox, { recursive: true, force: true })
}

try {
  await main()
} finally {
  if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
}

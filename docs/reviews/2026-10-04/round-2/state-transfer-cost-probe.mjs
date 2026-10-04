import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Проба полностью автономна: она использует временный dotenv-файл и временное
// хранилище, а production HTTP-сервер запускает в дочернем процессе со
// специальным предзагрузчиком через --import.
const sandbox = mkdtempSync(join(tmpdir(), 'skazanie-state-transfer-cost-'))
const emptyEnv = join(sandbox, 'empty.env')
writeFileSync(emptyEnv, '', 'utf8')
process.env.DOTENV_CONFIG_PATH = emptyEnv
process.env.ROUTERAI_API_KEY = ''

const fixture = await import('../../../../eval/world-data-measurements.mjs')
const { DEFAULT_COUNTS, countMemory, measureProductionStorage } = fixture
const { FileEventStore } = await import('../../../../server/event-store.mjs')
const { GAME_STATE_PROJECTOR_VERSION, applyGameEvent, normalizeCampaignState } = await import('../../../../server/rules-engine.mjs')
const { turnResultForViewer } = await import('../../../../server/viewer-projection.mjs')

const CAMPAIGN_ID = 'world-data-measurement'
const TAIL_EVENTS = 10
const FIXED_CLOCK = () => new Date('2026-09-16T00:00:00.000Z')
const REPS = 3
const clone = (value) => structuredClone(value)

function timed(operation) {
  const started = performance.now()
  const value = operation()
  return { value, elapsed_ms: performance.now() - started }
}

function jsonBytes(value) {
  const encoded = JSON.stringify(value)
  return encoded == null ? 0 : Buffer.byteLength(encoded, 'utf8')
}

function sha(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function summaryStats(values, suffix = 'ms') {
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = (fraction) => sorted.length
    ? Number(sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)].toFixed(3))
    : 0
  const unit = suffix ? `_${suffix}` : ''
  return {
    count: values.length,
    [`min${unit}`]: values.length ? Number(Math.min(...values).toFixed(3)) : 0,
    [`p50${unit}`]: percentile(0.5),
    [`p95${unit}`]: percentile(0.95),
    [`max${unit}`]: Number(Math.max(...values, 0).toFixed(3)),
    [`mean${unit}`]: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)) : 0,
  }
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

function smallState({ code = 'PERF-SMALL', actorId = 'hero' } = {}) {
  return normalizeCampaignState({
    sessionCode: code,
    campaign: 'Малая синтетическая кампания',
    activePlayerId: actorId,
    partyMemberIds: [actorId],
    state_version: 0,
    players: [
      { id: actorId, character: 'Герой', hp: 10, maxHp: 10, armor: 14, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, proficiency: 2, inventory: [], online: true, x: 0, y: 0 },
      { id: 'goblin', character: 'Гоблин', hp: 8, maxHp: 8, armor: 12, abilities: { str: 8, dex: 14, con: 10, int: 8, wis: 8, cha: 8 }, proficiency: 2, inventory: [], online: true },
    ],
    messages: [],
    scene: {
      title: 'Зал', location: 'Стенд', mood: '', objective: '', turn: 0,
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'floor', revealed: true },
        { x: 2, y: 0, type: 'floor', revealed: true },
      ],
    },
    ruleset_id: 'srd_5_2_1',
    ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'],
    engine_mode: 'enforce',
  })
}

function responseMemberBytes(key, value) {
  return Buffer.byteLength(JSON.stringify(key), 'utf8') + 1 + jsonBytes(value)
}

function wireValue(value) {
  const encoded = JSON.stringify(value)
  return encoded == null ? undefined : JSON.parse(encoded)
}

function responseComposition(body, rawText) {
  // Состав измеряется после той же нормализации JSON, что и реальный wire:
  // undefined/function/symbol-поля не должны попадать в сумму членов.
  body = wireValue(body) ?? {}
  const topLevel = Object.entries(body ?? {}).map(([key, value]) => ({
    key,
    value_bytes: jsonBytes(value),
    member_bytes: responseMemberBytes(key, value),
  }))
  const authoritative = body?.authoritative_state && typeof body.authoritative_state === 'object'
    ? Object.entries(body.authoritative_state).map(([key, value]) => ({
      key,
      value_bytes: jsonBytes(value),
      member_bytes: responseMemberBytes(key, value),
    }))
    : []
  const topByHash = new Map()
  for (const entry of Object.entries(body ?? {})) {
    const [key, value] = entry
    const bytes = jsonBytes(value)
    if (bytes < 128) continue
    const keyHash = sha(value)
    const list = topByHash.get(keyHash) ?? []
    list.push({ path: key, bytes })
    topByHash.set(keyHash, list)
  }
  const stateByHash = new Map()
  for (const entry of Object.entries(body?.authoritative_state ?? {})) {
    const [key, value] = entry
    const bytes = jsonBytes(value)
    if (bytes < 128) continue
    const keyHash = sha(value)
    const list = stateByHash.get(keyHash) ?? []
    list.push({ path: `authoritative_state.${key}`, bytes })
    stateByHash.set(keyHash, list)
  }
  const duplicateValues = []
  for (const [hash, topEntries] of topByHash) {
    const stateEntries = stateByHash.get(hash)
    if (!stateEntries) continue
    duplicateValues.push({ sha256: hash, bytes: topEntries[0].bytes, paths: [...topEntries, ...stateEntries].map((entry) => entry.path) })
  }
  const worldMemory = body?.authoritative_state?.worldMemory
  const worldMemoryFields = worldMemory && typeof worldMemory === 'object' && !Array.isArray(worldMemory)
    ? Object.entries(worldMemory).map(([key, value]) => ({
      key,
      value_bytes: jsonBytes(value),
      member_bytes: responseMemberBytes(key, value),
      record_count: Array.isArray(value) ? value.length : null,
    }))
    : []
  const worldMemoryByHash = new Map()
  for (const [key, value] of Object.entries(worldMemory ?? {})) {
    const bytes = jsonBytes(value)
    if (bytes < 128) continue
    const hash = sha(value)
    const list = worldMemoryByHash.get(hash) ?? []
    list.push({ path: `authoritative_state.worldMemory.${key}`, bytes })
    worldMemoryByHash.set(hash, list)
  }
  const worldMemoryDuplicates = [...worldMemoryByHash.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([hash, entries]) => ({ sha256: hash, bytes: entries[0].bytes, paths: entries.map((entry) => entry.path) }))
  const topMemberTotal = topLevel.reduce((sum, entry) => sum + entry.member_bytes, 0)
  const topLevelSyntaxBytes = 2 + Math.max(0, topLevel.length - 1)
  const partitionBytes = topMemberTotal + topLevelSyntaxBytes
  const rawBytes = Buffer.byteLength(rawText, 'utf8')
  assert.equal(partitionBytes, rawBytes, `JSON byte partition mismatch: ${partitionBytes} !== ${rawBytes}`)
  return {
    raw_bytes: rawBytes,
    top_level: topLevel,
    top_level_keys: topLevel.map((entry) => entry.key),
    top_level_member_bytes: topMemberTotal,
    top_level_syntax_bytes: topLevelSyntaxBytes,
    top_level_partition_bytes: partitionBytes,
    authoritative_state: {
      value_bytes: body?.authoritative_state == null ? 0 : jsonBytes(body.authoritative_state),
      fields: authoritative,
      world_memory: {
        value_bytes: worldMemory == null ? 0 : jsonBytes(worldMemory),
        fields: worldMemoryFields,
        exact_large_value_duplicates: worldMemoryDuplicates,
      },
    },
    exact_large_value_duplicates: duplicateValues,
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
  return {
    status: response.status,
    body,
    raw_text: text,
    elapsed_ms: Number((performance.now() - started).toFixed(3)),
    response_bytes: Buffer.byteLength(text, 'utf8'),
    headers: response.headers,
  }
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

async function stopChild(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP server did not stop')), 5_000)
    child.once('exit', () => { clearTimeout(timer); resolvePromise() })
    child.kill()
  })
}

function readRecords(recordsPath) {
  if (!existsSync(recordsPath)) return []
  return readFileSync(recordsPath, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
}

function commandRecordSummary(record) {
  const store = record.store ?? {}
  const persistence_ms = ['load', 'commit', 'getEvents', 'acknowledgeProjection', 'pendingProjection']
    .reduce((sum, name) => sum + Number(store[name]?.elapsed_ms ?? 0), 0)
  return {
    server_request_to_finish_ms: record.request_elapsed_ms,
    status: record.status,
    response_bytes: record.response_bytes,
    response_stringify_ms: record.response_stringify_ms,
    response_stringify_calls: record.response_stringify_calls,
    persistence_inclusive_ms: Number(persistence_ms.toFixed(3)),
    residual_ms: Number(Math.max(0, record.request_elapsed_ms - persistence_ms).toFixed(3)),
    store,
    all_stringify_ms: record.stringify_ms,
    all_stringify_calls: record.stringify_calls,
  }
}

async function measureProjectionAndSerialization(expandedState) {
  const user = { id: 'performance-player', role: 'player' }
  const input = {
    state_version: expandedState.state_version,
    room_version: 1,
    mechanics: [],
    authoritative_state: expandedState,
  }
  // Один вызов прогревает модуль и JIT и не входит в наблюдения.
  const warmed = turnResultForViewer(input, user, 'hero-1')
  JSON.stringify(warmed)
  const measurements = []
  for (let repeat = 1; repeat <= REPS; repeat += 1) {
    const projected = timed(() => turnResultForViewer(input, user, 'hero-1'))
    const serialized = timed(() => JSON.stringify(projected.value))
    measurements.push({
      repeat,
      projection_ms: Number(projected.elapsed_ms.toFixed(3)),
      serialization_ms: Number(serialized.elapsed_ms.toFixed(3)),
      response_bytes: Buffer.byteLength(serialized.value, 'utf8'),
      composition: responseComposition(projected.value, serialized.value),
    })
  }
  return {
    scope: 'same synthetic expanded authoritative state passed directly to turnResultForViewer and JSON.stringify; excludes HTTP socket, route orchestration, persistence and file IO',
    summary: {
      projection_ms: summaryStats(measurements.map((entry) => entry.projection_ms)),
      serialization_ms: summaryStats(measurements.map((entry) => entry.serialization_ms)),
      response_bytes: summaryStats(measurements.map((entry) => entry.response_bytes), ''),
    },
    measurements,
  }
}

async function measureHttp(initialState) {
  const storage = join(sandbox, 'http-storage')
  const recordsPath = join(sandbox, 'http-records.ndjson')
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const preload = fileURLToPath(new URL('./state-transfer-preload.mjs', import.meta.url))
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, 'server/index.mjs'], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      DOTENV_CONFIG_PATH: emptyEnv,
      ADMIN_SETUP_TOKEN: 'performance-setup-token',
      GAME_ENGINE_MODE: 'enforce',
      COOKIE_SECURE: 'false',
      STATE_COST_RECORDS: recordsPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (chunk) => { logs += String(chunk).slice(-2_000) })
  child.stderr.on('data', (chunk) => { logs += String(chunk).slice(-2_000) })
  try {
    await waitForHealth(baseUrl, child)
    const setup = await requestJson(`${baseUrl}/api/auth/setup-admin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: { name: 'Performance Admin', email: 'performance@example.test', password: 'performance-password', setupToken: 'performance-setup-token' },
    })
    assert.equal(setup.status, 201, logs)
    const adminCookie = setup.headers.get('set-cookie')?.split(';')[0]
    assert.ok(adminCookie, 'setup did not return an admin cookie')
    const adminHeaders = { 'Content-Type': 'application/json', Cookie: adminCookie }
    const registered = await requestJson(`${baseUrl}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: { name: 'Performance Player', email: 'performance-player@example.test', password: 'performance-player-password' },
    })
    assert.equal(registered.status, 201, JSON.stringify(registered.body))
    const playerCookie = registered.headers.get('set-cookie')?.split(';')[0]
    assert.ok(playerCookie, 'register did not return a player cookie')
    const playerHeaders = { 'Content-Type': 'application/json', Cookie: playerCookie }

    const small = smallState({ code: 'PERF-SMALL', actorId: 'hero' })
    const expanded = { ...smallState({ code: 'PERF-LARGE', actorId: 'hero-1' }), worldMemory: clone(initialState.worldMemory) }
    for (const [code, state] of [['PERF-SMALL', small], ['PERF-LARGE', smallState({ code: 'PERF-LARGE', actorId: 'hero-1' })]]) {
      const campaign = await requestJson(`${baseUrl}/api/campaigns`, {
        method: 'POST', headers: adminHeaders,
        body: { code, name: `HTTP стенд ${code}`, state },
      })
      assert.equal(campaign.status, 201, `${code}: ${JSON.stringify(campaign.body)}`)
    }
    const users = await requestJson(`${baseUrl}/api/admin/users`, { headers: { Cookie: adminCookie } })
    assert.equal(users.status, 200, JSON.stringify(users.body))
    const player = users.body.users.find((candidate) => candidate.email === 'performance-player@example.test')
    assert.ok(player, 'player was not listed by admin')
    const assigned = await requestJson(`${baseUrl}/api/admin/users/${player.id}`, {
      method: 'PATCH', headers: adminHeaders, body: { heroIds: ['hero', 'hero-1'] },
    })
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body))

    const eventRoot = join(storage, 'engine')
    const expansionStore = new FileEventStore({
      rootDir: eventRoot,
      reducer: applyGameEvent,
      normalizeState: normalizeCampaignState,
      reducerNormalizesInput: true,
      snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
    })
    await expansionStore.commit({
      campaignId: 'PERF-LARGE',
      expectedStateVersion: 0,
      idempotencyKey: 'state-cost-expand',
      commandId: 'state-cost-expand',
      events: [{
        event_id: 'state-cost-expand-event',
        event_type: 'LegacyStateImported',
        actor_id: null,
        target_ids: [],
        source_rule_ids: [],
        payload: { state: expanded, source: 'state-cost-probe' },
      }],
    })
    await expansionStore.createSnapshot('PERF-LARGE')

    const series = {}
    for (const [code, actorId] of [['PERF-SMALL', 'hero'], ['PERF-LARGE', 'hero-1']]) {
      const rows = []
      for (let index = 1; index <= REPS; index += 1) {
        const destination = index % 2 === 1 ? { x: 2, y: 0 } : { x: 0, y: 0 }
        const result = await requestJson(`${baseUrl}/api/campaigns/${code}/commands`, {
          method: 'POST',
          headers: playerHeaders,
          body: {
            idempotency_key: `state-cost-${code}-${index}`,
            message: `HTTP movement ${code} ${index}`,
            command: { command_type: 'MoveActor', actor_id: actorId, to: destination },
          },
        })
        assert.equal(result.status, 200, `${code} move ${index}: ${JSON.stringify(result.body)}`)
        const actor = result.body.authoritative_state?.players?.find((candidate) => String(candidate.id) === actorId)
        assert.deepEqual({ x: actor?.x, y: actor?.y }, destination, `${code} did not reach destination`)
        rows.push({
          index,
          client_fetch_body_elapsed_ms: result.elapsed_ms,
          response_bytes: result.response_bytes,
          composition: responseComposition(result.body, result.raw_text),
        })
      }
      series[code === 'PERF-LARGE' ? 'expanded' : 'small'] = {
        reps: REPS,
        summary: {
          client_fetch_body_elapsed_ms: summaryStats(rows.map((entry) => entry.client_fetch_body_elapsed_ms)),
          response_bytes: summaryStats(rows.map((entry) => entry.response_bytes), ''),
        },
        measurements: rows,
      }
    }
    const expandedLoaded = await expansionStore.load('PERF-LARGE')
    assert.equal(countMemory(expandedLoaded.state.worldMemory).facts, DEFAULT_COUNTS.facts, 'expanded state lost facts')
    return {
      no_llm: true,
      reps: REPS,
      timing_boundaries: {
        client_fetch_body: 'requestJson performance.now() around fetch() plus response.text()',
        server_request_to_finish: 'child preloader request event to ServerResponse finish event',
      },
      fixture: {
        expanded_state_bytes: jsonBytes(expandedLoaded.state),
        expanded_counts: countMemory(expandedLoaded.state.worldMemory),
        expansion: 'LegacyStateImported through FileEventStore, then production projector snapshot; same shape as the previous full HTTP benchmark',
      },
      series,
      child_records: readRecords(recordsPath)
        .filter((record) => record.path === '/api/campaigns/PERF-SMALL/commands' || record.path === '/api/campaigns/PERF-LARGE/commands')
        .map(commandRecordSummary),
    }
  } finally {
    await stopChild(child)
  }
}

async function main() {
  const outputArg = process.argv.find((arg) => arg.startsWith('--output='))
  const output = resolve(outputArg ? outputArg.slice('--output='.length) : 'docs/reviews/2026-10-04/round-2/state-transfer-cost.json')
  const fixtureRoot = join(sandbox, 'fixture')
  const seed = await measureProductionStorage({
    counts: DEFAULT_COUNTS,
    productionRootDir: fixtureRoot,
    keepStorage: true,
    productionTail: TAIL_EVENTS,
    snapshotEvery: TAIL_EVENTS,
  })
  const initialState = initialStateFromFixture(fixtureRoot)
  const http = await measureHttp(initialState)
  const expandedState = normalizeCampaignState({
    ...smallState({ code: 'PERF-LARGE', actorId: 'hero-1' }),
    worldMemory: clone(initialState.worldMemory),
  })
  const isolated = await measureProjectionAndSerialization(expandedState)
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    command: process.argv.slice(2),
    environment: { node: process.version, platform: process.platform, arch: process.arch, no_llm: true, storage: 'temporary', serialized_requests: true },
    fixture: {
      counts: DEFAULT_COUNTS,
      state_bytes: jsonBytes(initialState),
      source: 'eval/world-data-measurements.mjs:measureProductionStorage',
      seed_timings: seed.timings,
    },
    http,
    isolated_projection: isolated,
    methodology: {
      response_member_bytes: 'For each top-level JSON member, member_bytes = UTF-8 bytes of JSON.stringify(key) + colon + UTF-8 bytes of JSON.stringify(value). Object braces and commas are reported separately as top_level_syntax_bytes.',
      duplicate_scan: 'Exact SHA-256 equality of JSON.stringify values for top-level response fields versus authoritative_state fields and for authoritative_state.worldMemory fields, limited to values >=128 bytes; this reports byte-identical payloads only and does not claim semantic overlap.',
      stage_timings: 'Child --import preloader wraps FileEventStore load/commit/getEvents/acknowledgeProjection/pendingProjection and response JSON.stringify within AsyncLocalStorage request scopes. server_request_to_finish_ms is measured from the child request event to ServerResponse finish; client_fetch_body_elapsed_ms is measured independently around fetch plus response.text(). persistence_inclusive_ms is a sum of inclusive calls and can overlap nested calls; residual_ms is server finish time minus that sum, so it is a diagnostic bound rather than a CPU attribution.',
      confidence: 'Three serial requests per campaign on one local Windows process, no concurrent benchmark and no LLM. The HTTP request timings are wall-clock observations; isolated projection timings are same-fixture CPU-adjacent measurements and must not be added to HTTP wall time.',
    },
  }
  mkdirSync(resolve(output, '..'), { recursive: true })
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  rmSync(sandbox, { recursive: true, force: true })
}

try {
  await main()
} finally {
  if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
}

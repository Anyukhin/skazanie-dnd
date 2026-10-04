// Ограниченный live-backup probe, источник runtime зафиксирован на
// e1d927f5aa68dc9eca912b527cccf3974ba3e9e7. Probe не меняет server/ и не
// читает рабочие .env/storage: оба процесса получают собственный временный
// каталог. Пауза после readdirSync(events) нужна только для доказательства
// конкретного interleave; архив, проверка и восстановление остаются штатными.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileEventStore } from '../../../../server/event-store.mjs'
import { MapStore } from '../../../../server/map-store.mjs'
import {
  GAME_REDUCER_VERSION,
  GAME_STATE_PROJECTOR_VERSION,
  applyGameEvent,
  normalizeCampaignState,
} from '../../../../server/rules-engine.mjs'
import { createTacticalMap, serializeTacticalMap } from '../../../../server/tactical-map.mjs'

const CAMPAIGN_ID = 'LIVE-BACKUP'
const SECRET = 'probe-only-secret-with-at-least-32-bytes'
const PROBE_SOURCE_COMMIT = 'e1d927f5aa68dc9eca912b527cccf3974ba3e9e7'
const SCRIPT_FILE = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SCRIPT_FILE), '../../../..')
const EVENT_FILE = /^(\d{16})-(\d{16})-([a-zA-Z0-9-]+)\.json$/u
const SNAPSHOT_FILE = /^(\d{16})\.json$/u
const MAP_REF_MARKER = 'skazanie:map-ref-v1'

function productionStore(storageDir) {
  const engineRoot = join(storageDir, 'engine')
  return new FileEventStore({
    rootDir: engineRoot,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    reducerNormalizesInput: true,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
    reducerVersion: GAME_REDUCER_VERSION,
    mapStore: new MapStore({ rootDir: engineRoot }),
  })
}

function canonical(value) {
  if (ArrayBuffer.isView(value)) return Array.from(value)
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function digestSerializedMap(value) {
  return sha256(JSON.stringify(value))
}

function mapRefsIn(value, result = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) mapRefsIn(item, result)
    return result
  }
  if (!value || typeof value !== 'object') return result
  if (value.marker === MAP_REF_MARKER && typeof value.hash === 'string') result.add(value.hash)
  for (const child of Object.values(value)) mapRefsIn(child, result)
  return result
}

function filesUnder(directory, predicate = () => true, prefix = '') {
  if (!existsSync(directory)) return []
  const result = []
  for (const name of readdirSync(directory).sort()) {
    const absolute = join(directory, name)
    const relative = prefix ? `${prefix}/${name}` : name
    if (fs.statSync(absolute).isDirectory()) result.push(...filesUnder(absolute, predicate, relative))
    else if (predicate(name, absolute)) result.push({ absolute, relative })
  }
  return result
}

function rawStorageSummary(storageDir) {
  const engineRoot = join(storageDir, 'engine')
  const campaignsRoot = join(engineRoot, 'campaigns')
  const campaignDirectoryName = readdirSync(campaignsRoot).find((name) => existsSync(join(campaignsRoot, name, 'events')))
  assert.ok(campaignDirectoryName, 'production event-store campaign directory is missing')
  const campaignDir = join(campaignsRoot, campaignDirectoryName)
  const eventFiles = readdirSync(join(campaignDir, 'events')).filter((name) => EVENT_FILE.test(name)).sort()
  const commits = eventFiles.map((name) => JSON.parse(readFileSync(join(campaignDir, 'events', name), 'utf8')))
  let expectedVersion = 0
  let eventLogContiguous = true
  for (const commit of commits) {
    if (Number(commit.state_version_before) !== expectedVersion
      || Number(commit.state_version_after) !== expectedVersion + commit.events.length) eventLogContiguous = false
    for (const [index, event] of (commit.events ?? []).entries()) {
      if (Number(event.state_version_before) !== expectedVersion + index
        || Number(event.state_version_after) !== expectedVersion + index + 1) eventLogContiguous = false
    }
    expectedVersion = Number(commit.state_version_after)
  }

  const metadataFile = join(campaignDir, 'metadata.json')
  const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'))
  const snapshotFiles = readdirSync(join(campaignDir, 'snapshots')).filter((name) => SNAPSHOT_FILE.test(name)).sort()
  const snapshots = snapshotFiles.map((name) => JSON.parse(readFileSync(join(campaignDir, 'snapshots', name), 'utf8')))
  const snapshotChecksumsValid = snapshots.every((snapshot) => snapshot.checksum === sha256(canonicalJson(snapshot.state)))
  const snapshotVersions = snapshots.map((snapshot) => Number(snapshot.state_version)).sort((a, b) => a - b)
  const refs = new Set()
  for (const snapshot of snapshots) mapRefsIn(snapshot.state, refs)
  const mapFiles = filesUnder(join(engineRoot, 'maps'), (name) => name.endsWith('.json'))
  const mapFilesByHash = new Map(mapFiles.map(({ absolute, relative }) => [basename(relative, '.json'), absolute]))
  const missingMapRefs = [...refs].filter((hash) => !mapFilesByHash.has(hash))
  const mapHashMismatches = []
  for (const hash of refs) {
    const file = mapFilesByHash.get(hash)
    if (!file) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (digestSerializedMap(parsed) !== hash) mapHashMismatches.push(hash)
    } catch {
      mapHashMismatches.push(hash)
    }
  }
  return {
    campaign_directory: campaignDirectoryName,
    event_files: eventFiles,
    event_commit_versions: commits.map((commit) => [Number(commit.state_version_before), Number(commit.state_version_after)]),
    event_head: expectedVersion,
    event_log_contiguous: eventLogContiguous,
    metadata_state_version: Number(metadata.state_version),
    metadata_current_version: Number(metadata.current_version),
    snapshot_files: snapshotFiles,
    snapshot_versions: snapshotVersions,
    snapshot_checksums_valid: snapshotChecksumsValid,
    map_ref_hashes: [...refs].sort(),
    map_files: mapFiles.map(({ relative }) => relative),
    missing_map_refs: missingMapRefs,
    map_hash_mismatches: mapHashMismatches,
  }
}

async function inspectProductionState(storageDir) {
  const store = productionStore(storageDir)
  const loaded = await store.load(CAMPAIGN_ID)
  const replayed = await store.replay(CAMPAIGN_ID, { useSnapshots: false })
  const raw = rawStorageSummary(storageDir)
  const loadedFingerprint = sha256(canonicalJson(loaded.state))
  const replayedFingerprint = sha256(canonicalJson(replayed.state))
  const healthy = raw.event_log_contiguous
    && raw.metadata_state_version === raw.event_head
    && raw.metadata_current_version === raw.event_head
    && raw.snapshot_checksums_valid
    && Math.max(...raw.snapshot_versions, 0) <= raw.event_head
    && raw.missing_map_refs.length === 0
    && raw.map_hash_mismatches.length === 0
    && loaded.state_version === raw.event_head
    && replayed.state_version === raw.event_head
    && loadedFingerprint === replayedFingerprint
  return {
    healthy,
    loaded_state_version: loaded.state_version,
    replayed_state_version: replayed.state_version,
    loaded_fingerprint: loadedFingerprint,
    replayed_fingerprint: replayedFingerprint,
    raw,
  }
}

function writeReport(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function waitForFileSync(file, timeoutMs = 60_000) {
  const started = Date.now()
  while (!existsSync(file)) {
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for ${file}`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}

async function waitForFile(file, child, timeoutMs = 60_000) {
  const started = Date.now()
  while (!existsSync(file)) {
    if (child.exitCode !== null) throw new Error(`Child exited before ${basename(file)}: ${child.exitCode}`)
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for ${file}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

function childEnv(root, files) {
  return {
    ...process.env,
    SKAZANIE_PROBE_ROOT: root,
    SKAZANIE_PROBE_STORAGE: join(root, 'storage'),
    SKAZANIE_PROBE_BACKUP: join(root, 'vault', 'live.skzbackup'),
    SKAZANIE_PROBE_SECRET: SECRET,
    SKAZANIE_PROBE_BASELINE: files.baseline,
    SKAZANIE_PROBE_GO: files.go,
    SKAZANIE_PROBE_AFTER: files.after,
    SKAZANIE_PROBE_EVENTS_GATE: files.eventsGate,
    SKAZANIE_PROBE_RELEASE: files.release,
    SKAZANIE_PROBE_BACKUP_RESULT: files.backupResult,
    SKAZANIE_PROBE_ERROR: files.error,
  }
}

function startChild(mode, root, files) {
  return spawn(process.execPath, [SCRIPT_FILE, mode], {
    cwd: REPO_ROOT,
    env: childEnv(root, files),
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await new Promise((resolvePromise) => child.once('exit', resolvePromise))
}

async function writerMode() {
  const storageDir = process.env.SKAZANIE_PROBE_STORAGE
  const files = {
    baseline: process.env.SKAZANIE_PROBE_BASELINE,
    go: process.env.SKAZANIE_PROBE_GO,
    after: process.env.SKAZANIE_PROBE_AFTER,
    error: process.env.SKAZANIE_PROBE_ERROR,
  }
  try {
    mkdirSync(storageDir, { recursive: true })
    const store = productionStore(storageDir)
    const map = serializeTacticalMap(createTacticalMap({
      width: 2,
      height: 2,
      locationId: 'live-backup-probe',
      seed: 'live-backup-probe',
      fill: { passable: true, revealed: true, material: 'stone' },
    }))
    await store.initializeCampaign({
      campaign_id: CAMPAIGN_ID,
      initial_state: {
        campaign: 'live backup probe',
        scene: { title: 'Проверка резервной копии', location: 'live-backup-probe', map },
        players: [],
      },
    })
    await store.commit({
      campaign_id: CAMPAIGN_ID,
      expected_state_version: 0,
      idempotency_key: 'live-backup-baseline',
      command_id: 'live-backup-baseline',
      events: [{ event_type: 'LiveBackupProbeBaseline', payload: { marker: 'before' } }],
    })
    const before = await inspectProductionState(storageDir)
    assert.equal(before.healthy, true, JSON.stringify(before))
    writeReport(files.baseline, before)
    waitForFileSync(files.go)
    await store.commit({
      campaign_id: CAMPAIGN_ID,
      expected_state_version: 1,
      idempotency_key: 'live-backup-concurrent',
      command_id: 'live-backup-concurrent',
      events: [{ event_type: 'LiveBackupProbeConcurrent', payload: { marker: 'after' } }],
    })
    const after = await inspectProductionState(storageDir)
    assert.equal(after.healthy, true, JSON.stringify(after))
    writeReport(files.after, after)
  } catch (error) {
    writeReport(files.error, { mode: 'writer', message: error instanceof Error ? error.message : String(error), code: error?.code ?? null })
    process.exitCode = 1
  }
}

async function backupMode() {
  const sourceDir = process.env.SKAZANIE_PROBE_STORAGE
  const backupFile = process.env.SKAZANIE_PROBE_BACKUP
  const gateFile = process.env.SKAZANIE_PROBE_EVENTS_GATE
  const releaseFile = process.env.SKAZANIE_PROBE_RELEASE
  const resultFile = process.env.SKAZANIE_PROBE_BACKUP_RESULT
  const errorFile = process.env.SKAZANIE_PROBE_ERROR
  let gateObserved = false
  const originalReaddirSync = fs.readdirSync
  fs.readdirSync = function instrumentedReaddirSync(path, ...args) {
    const result = originalReaddirSync.call(this, path, ...args)
    if (!gateObserved && basename(String(path)) === 'events') {
      gateObserved = true
      writeReport(gateFile, { directory: String(path), entries: result })
      waitForFileSync(releaseFile)
    }
    return result
  }
  syncBuiltinESMExports()
  try {
    const { createStorageBackup, verifyStorageBackup } = await import('../../../../server/backup-service.mjs')
    const created = createStorageBackup({ sourceDir, backupFile, secret: process.env.SKAZANIE_PROBE_SECRET })
    const verified = verifyStorageBackup({ backupFile, secret: process.env.SKAZANIE_PROBE_SECRET })
    assert.equal(gateObserved, true, 'backup did not enumerate the production event directory')
    writeReport(resultFile, { created, verified, source_commit: PROBE_SOURCE_COMMIT })
  } catch (error) {
    writeReport(errorFile, { mode: 'backup', message: error instanceof Error ? error.message : String(error), code: error?.code ?? null })
    process.exitCode = 1
  }
}

async function parentMode() {
  const root = fs.mkdtempSync(join(tmpdir(), 'skazanie-round4-live-backup-'))
  const files = {
    baseline: join(root, 'baseline.json'),
    go: join(root, 'writer-go'),
    after: join(root, 'after.json'),
    eventsGate: join(root, 'events-gate.json'),
    release: join(root, 'backup-release'),
    backupResult: join(root, 'backup-result.json'),
    error: join(root, 'child-error.json'),
  }
  let writer = null
  let backup = null
  try {
    writer = startChild('writer', root, files)
    await waitForFile(files.baseline, writer)
    const before = JSON.parse(readFileSync(files.baseline, 'utf8'))

    backup = startChild('backup', root, files)
    const gate = await waitForFile(files.eventsGate, backup)
    writeFileSync(files.go, 'start concurrent commit\n', 'utf8')
    const after = await waitForFile(files.after, writer)
    const sourceAfter = await inspectProductionState(join(root, 'storage'))
    assert.equal(sourceAfter.healthy, true, JSON.stringify(sourceAfter))
    writeFileSync(files.release, 'continue backup\n', 'utf8')
    const backupResult = await waitForFile(files.backupResult, backup)
    const { compareStorageToBackup, restoreStorageBackup, verifyStorageBackup } = await import('../../../../server/backup-service.mjs')
    const backupFile = join(root, 'vault', 'live.skzbackup')
    const verifiedAgain = verifyStorageBackup({ backupFile, secret: SECRET })
    const sourceAfterReconciliation = compareStorageToBackup({ sourceDir: join(root, 'storage'), backupFile, secret: SECRET })
    const restoredDir = join(root, 'restored-storage')
    const restored = restoreStorageBackup({ backupFile, targetDir: restoredDir, secret: SECRET })
    const restoredState = await inspectProductionState(restoredDir)
    const restoredMatchesBefore = restoredState.loaded_fingerprint === before.loaded_fingerprint
    const restoredMatchesAfter = restoredState.loaded_fingerprint === after.loaded_fingerprint
    const report = {
      source_commit: PROBE_SOURCE_COMMIT,
      mechanism: 'instrumented pause after backup readdirSync(events), before createStorageBackup reads file bytes',
      interleave: {
        events_directory_entries_seen_by_backup: gate.entries,
        event_file_missing_from_backup_listing_after_writer_commit: after.raw.event_files.filter((name) => !gate.entries.includes(name)),
      },
      source_before: before,
      source_after: sourceAfter,
      writer_after: after,
      primary_backup: {
        created: backupResult.created,
        verified_in_backup_process: backupResult.verified,
        verified_again_in_parent: verifiedAgain,
      },
      source_after_reconciliation: sourceAfterReconciliation,
      restore: {
        ...restored,
        state: restoredState,
        matches_healthy_before_state: restoredMatchesBefore,
        matches_healthy_after_state: restoredMatchesAfter,
        consistent_domain_cut: restoredState.healthy,
      },
      finding: {
        live_concurrent_backup_can_capture_inconsistent_cut: !restoredState.healthy,
        why: 'Архив содержит список событий до commit и metadata после commit; аутентификация файлов проходит, но event head и версия metadata расходятся.',
        operational_scope: 'Для общего backup create документация и CLI не закрепляют остановку writer; явная остановка описана для миграции и отдельных recovery-процедур. Probe подтверждает разрыв координации при живом FileEventStore, но не утверждает, что уже обещан безопасный live backup.',
      },
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await stopChild(backup)
    await stopChild(writer)
    rmSync(root, { recursive: true, force: true })
  }
}

const mode = process.argv[2] ?? 'parent'
if (mode === 'writer') await writerMode()
else if (mode === 'backup') await backupMode()
else if (mode === 'parent') await parentMode()
else throw new Error(`Unknown probe mode: ${mode}`)

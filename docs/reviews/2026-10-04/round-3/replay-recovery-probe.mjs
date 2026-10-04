import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileEventStore } from '../../../../server/event-store.mjs'
import { MapStore } from '../../../../server/map-store.mjs'
import { createStorageBackup, restoreStorageBackup } from '../../../../server/backup-service.mjs'
import { auditLegacyCutover } from '../../../../server/cutover-audit.mjs'
import { applyGameEvent, normalizeCampaignState } from '../../../../server/rules-engine.mjs'

const SECRET = 'round-three-probe-secret-with-at-least-32-bytes'
const AAD = Buffer.from('skazanie:encrypted-storage-backup-v1', 'utf8')

function reducer(state, event) {
  const next = structuredClone(state)
  if (event.event_type === 'Increment') next.counter = Number(next.counter ?? 0) + Number(event.payload?.amount ?? 0)
  return next
}

function layout(root) {
  return join(root, 'campaigns', readdirSync(join(root, 'campaigns'))[0])
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function missingEventFile() {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-round3-missing-event-'))
  try {
    const initial = { counter: 0 }
    const store = new FileEventStore({
      rootDir: root,
      reducer,
      normalizeState: (state) => state,
      initialStateFactory: () => structuredClone(initial),
      snapshotEvery: 1,
    })
    await store.initializeCampaign({ campaign_id: 'MISSING-EVENT', initial_state: initial })
    await store.commit({
      campaign_id: 'MISSING-EVENT',
      expected_state_version: 0,
      idempotency_key: 'increment-1',
      events: [{ event_type: 'Increment', payload: { amount: 1 } }],
    })
    const campaign = layout(root)
    const eventFiles = readdirSync(join(campaign, 'events'))
    assert.equal(eventFiles.length, 1)
    unlinkSync(join(campaign, 'events', eventFiles[0]))
    const reopened = new FileEventStore({
      rootDir: root,
      reducer,
      normalizeState: (state) => state,
      initialStateFactory: () => structuredClone(initial),
      snapshotEvery: 1,
    })
    const loaded = await reopened.load('MISSING-EVENT')
    const metadata = await reopened.getMetadata('MISSING-EVENT')
    return {
      retained_snapshot_versions: readdirSync(join(campaign, 'snapshots')).sort(),
      loaded_state_version: loaded.state_version,
      loaded_counter: loaded.state.counter,
      metadata_state_version: metadata.state_version,
      metadata_file_state_version: JSON.parse(readFileSync(join(campaign, 'metadata.json'), 'utf8')).state_version,
      pending_projection: await reopened.pendingProjection('MISSING-EVENT'),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function missingInitialSnapshot() {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-round3-missing-initial-'))
  try {
    const initial = { campaign: 'Seed only in snapshot', counter: 7, players: [{ id: 'hero-1' }] }
    const store = new FileEventStore({ rootDir: root, reducer, snapshotEvery: 0 })
    await store.initializeCampaign({ campaign_id: 'MISSING-SEED', initial_state: initial })
    const campaign = layout(root)
    unlinkSync(join(campaign, 'snapshots', '0000000000000000.json'))
    const reopened = new FileEventStore({ rootDir: root, reducer, snapshotEvery: 0 })
    const loaded = await reopened.load('MISSING-SEED')
    return {
      snapshot_files: readdirSync(join(campaign, 'snapshots')).sort(),
      loaded_without_error: true,
      original_campaign: initial.campaign,
      loaded_campaign: loaded.state.campaign ?? null,
      loaded_counter: loaded.state.counter ?? null,
      loaded_state_keys: Object.keys(loaded.state).sort(),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function changedMapBlob() {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-round3-map-integrity-'))
  try {
    const map = { width: 1, height: 1, cells: [{ x: 0, y: 0, terrain: 'floor' }] }
    const initial = { counter: 0, scene: { map, cells: [...map.cells] } }
    const mapStore = new MapStore({ rootDir: root })
    const storeOptions = {
      rootDir: root,
      reducer,
      normalizeState: (state) => state,
      initialStateFactory: () => structuredClone(initial),
      snapshotEvery: 1,
      mapStore,
    }
    const store = new FileEventStore(storeOptions)
    await store.initializeCampaign({ campaign_id: 'MAP-INTEGRITY', initial_state: initial })
    await store.commit({
      campaign_id: 'MAP-INTEGRITY',
      expected_state_version: 0,
      idempotency_key: 'increment-1',
      events: [{ event_type: 'Increment', payload: { amount: 1 } }],
    })
    const snapshot = JSON.parse(readFileSync(join(layout(root), 'snapshots', '0000000000000001.json'), 'utf8'))
    const hash = snapshot.state.scene.map.hash
    const mapFile = mapStore.fileFor(hash)
    const corrupted = { ...map, cells: [{ x: 0, y: 0, terrain: 'lava' }] }
    writeFileSync(mapFile, `${JSON.stringify(corrupted)}\n`, 'utf8')
    mapStore.cache.clear()
    const reopened = new FileEventStore({ ...storeOptions, mapStore: new MapStore({ rootDir: root }) })
    const loaded = await reopened.load('MAP-INTEGRITY')
    const replayed = await reopened.replay('MAP-INTEGRITY', { use_snapshots: false })
    const strictReplay = await reopened.replay('MAP-INTEGRITY', { use_snapshots: false, from_initial: true })
    return {
      ref_hash: hash,
      changed_blob_hash: digest(Buffer.from(JSON.stringify(corrupted))),
      map_hash_matches_ref: digest(Buffer.from(JSON.stringify(corrupted))) === hash,
      missing_refs: [],
      snapshot_checksum_still_valid: loaded.state.scene.map.cells[0].terrain === 'lava',
      loaded_terrain: loaded.state.scene.map.cells[0].terrain,
      replay_terrain: replayed.state.scene.map.cells[0].terrain,
      from_initial_replay_terrain: strictReplay.state.scene.map.cells[0].terrain,
      replay_version: replayed.state_version,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function corruptSnapshotSelection() {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-round3-corrupt-snapshot-'))
  try {
    const initial = { counter: 0 }
    const options = {
      rootDir: root,
      reducer,
      normalizeState: (state) => state,
      initialStateFactory: () => structuredClone(initial),
      snapshotEvery: 1,
    }
    const store = new FileEventStore(options)
    await store.initializeCampaign({ campaign_id: 'CORRUPT-SNAPSHOT', initial_state: initial })
    await store.commit({
      campaign_id: 'CORRUPT-SNAPSHOT',
      expected_state_version: 0,
      idempotency_key: 'increment-1',
      events: [{ event_type: 'Increment', payload: { amount: 1 } }],
    })
    const campaign = layout(root)
    const snapshotFile = join(campaign, 'snapshots', '0000000000000001.json')
    const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'))
    snapshot.state.counter = 999
    writeFileSync(snapshotFile, `${JSON.stringify(snapshot)}\n`, 'utf8')
    const reopened = new FileEventStore(options)
    let loadError = null
    try {
      await reopened.load('CORRUPT-SNAPSHOT')
    } catch (error) {
      loadError = { code: error?.code ?? null, message: String(error?.message ?? error) }
    }
    const olderSnapshotReplay = await reopened.replay('CORRUPT-SNAPSHOT', { use_snapshots: false })
    return {
      valid_older_snapshot_present: existsSync(join(campaign, 'snapshots', '0000000000000000.json')),
      load_error: loadError,
      replay_without_snapshots_counter: olderSnapshotReplay.state.counter,
      replay_without_snapshots_version: olderSnapshotReplay.state_version,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function encryptedPayload(payload) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(SECRET, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return {
    schema_version: 1,
    format: 'skazanie:encrypted-storage-backup-v1',
    kdf: { name: 'scrypt', salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    ciphertext: ciphertext.toString('base64'),
  }
}

function conflictingBackup(root) {
  const entries = [
    ['a', Buffer.from('file')],
    ['a/b', Buffer.from('child')],
  ].map(([path, bytes]) => ({ path, size_bytes: bytes.length, sha256: digest(bytes), data: bytes.toString('base64') }))
  const payload = {
    schema_version: 1,
    format: 'skazanie:encrypted-storage-backup-v1',
    created_at: '2026-10-04T00:00:00.000Z',
    file_count: entries.length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    files: entries,
  }
  const backupFile = join(root, 'conflicting.skzbackup')
  writeFileSync(backupFile, `${JSON.stringify(encryptedPayload(payload))}\n`, 'utf8')
  return backupFile
}

function backupPathConflict() {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-round3-restore-conflict-'))
  try {
    const backupFile = conflictingBackup(root)
    const target = join(root, 'restored')
    let error = null
    try {
      restoreStorageBackup({ backupFile, targetDir: target, secret: SECRET })
    } catch (caught) {
      error = { code: caught?.code ?? null, name: caught?.name ?? null, message: String(caught?.message ?? caught) }
    }
    return {
      error,
      partial_target_entries: existsSync(target) ? readdirSync(target).sort() : [],
      retry_target_error: (() => {
        try {
          restoreStorageBackup({ backupFile, targetDir: target, secret: SECRET })
          return null
        } catch (caught) {
          return { code: caught?.code ?? null, message: String(caught?.message ?? caught) }
        }
      })(),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function backupDomainConsistency() {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-round3-backup-domain-'))
  try {
    const source = join(root, 'source')
    const engineRoot = join(source, 'engine')
    const eventStore = new FileEventStore({
      rootDir: engineRoot,
      reducer: applyGameEvent,
      normalizeState: normalizeCampaignState,
      mapStore: new MapStore({ rootDir: engineRoot }),
    })
    await eventStore.initializeCampaign({
      campaign_id: 'DOMAIN-BACKUP',
      initial_state: normalizeCampaignState({ sessionCode: 'DOMAIN-BACKUP', campaign: 'Domain backup', players: [] }),
    })
    const state = (await eventStore.load('DOMAIN-BACKUP')).state
    const rooms = join(source, 'rooms')
    mkdirSync(rooms, { recursive: true })
    const room = { version: 1, state: { ...state, state_version: 1 }, updatedAt: '2026-10-04T00:00:00.000Z' }
    // Такой каталог проходит byte-for-byte backup, но room уже опережает
    // authoritative event stream на одну версию.
    writeFileSync(join(rooms, 'DOMAIN-BACKUP.json'), `${JSON.stringify(room)}\n`, { encoding: 'utf8', flag: 'w' })
    const backupFile = join(root, 'domain.skzbackup')
    const created = createStorageBackup({ sourceDir: source, backupFile, secret: SECRET })
    const target = join(root, 'restored')
    const restored = restoreStorageBackup({ backupFile, targetDir: target, secret: SECRET })
    const audit = await auditLegacyCutover({ storageRoot: target })
    return {
      backup_file_count: created.file_count,
      byte_reconciliation_identical: restored.reconciliation.identical,
      domain_audit_ready: audit.ready,
      domain_audit_blockers: audit.blockers.map((entry) => entry.code),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const result = {
  missing_event_file: await missingEventFile(),
  missing_initial_snapshot: await missingInitialSnapshot(),
  changed_map_blob: await changedMapBlob(),
  corrupt_snapshot_selection: await corruptSnapshotSelection(),
  backup_domain_consistency: await backupDomainConsistency(),
  backup_restore_path_conflict: backupPathConflict(),
}
console.log(JSON.stringify(result, null, 2))

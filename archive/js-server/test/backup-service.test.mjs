import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BackupError,
  STORAGE_WRITER_MARKER,
  claimStorageWriter,
  compareStorageToBackup,
  createStorageBackup,
  inspectStorageWriter,
  restoreStorageBackup,
  verifyStorageBackup,
} from '../server/backup-service.mjs'

const SECRET = 'test-only-backup-secret-with-more-than-32-bytes'

test('encrypted backup verifies, restores into an empty directory and reconciles byte-for-byte', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-backup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'storage')
  mkdirSync(join(source, 'engine', 'campaign-a', 'events'), { recursive: true })
  writeFileSync(join(source, 'auth.json'), '{"users":[{"id":"u1"}]}\\n', 'utf8')
  writeFileSync(join(source, 'engine', 'campaign-a', 'events', 'event.json'), '{"event_type":"SceneAdvanced"}\\n', 'utf8')
  const backupFile = join(root, 'backups', 'storage.skzbackup')

  const created = createStorageBackup({
    sourceDir: source,
    backupFile,
    secret: SECRET,
    now: () => new Date('2026-07-24T20:00:00.000Z'),
  })
  assert.equal(created.file_count, 2)
  assert.equal(created.encrypted, true)
  assert.doesNotMatch(readFileSync(backupFile, 'utf8'), /SceneAdvanced|users/u)

  const verified = verifyStorageBackup({ backupFile, secret: SECRET })
  assert.equal(verified.verified, true)
  const target = join(root, 'restored')
  const restored = restoreStorageBackup({ backupFile, targetDir: target, secret: SECRET })
  assert.equal(restored.reconciliation.identical, true)
  assert.equal(readFileSync(join(target, 'auth.json'), 'utf8'), readFileSync(join(source, 'auth.json'), 'utf8'))
  assert.deepEqual(compareStorageToBackup({ sourceDir: target, backupFile, secret: SECRET }), {
    identical: true, missing: [], unexpected: [], changed: [],
  })
})

test('backup authentication, immutable output and non-empty restore target fail closed', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-backup-fail-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'storage')
  mkdirSync(source)
  writeFileSync(join(source, 'room.json'), '{"version":1}\\n', 'utf8')
  const backupFile = join(root, 'backup.skzbackup')
  createStorageBackup({ sourceDir: source, backupFile, secret: SECRET })

  assert.throws(
    () => verifyStorageBackup({ backupFile, secret: `${SECRET}-wrong` }),
    (error) => error instanceof BackupError && error.code === 'BACKUP_AUTHENTICATION_FAILED',
  )
  assert.throws(
    () => createStorageBackup({ sourceDir: source, backupFile, secret: SECRET }),
    (error) => error instanceof BackupError && error.code === 'BACKUP_ALREADY_EXISTS',
  )
  const occupied = join(root, 'occupied')
  mkdirSync(occupied)
  writeFileSync(join(occupied, 'keep.txt'), 'keep', 'utf8')
  assert.throws(
    () => restoreStorageBackup({ backupFile, targetDir: occupied, secret: SECRET }),
    (error) => error instanceof BackupError && error.code === 'RESTORE_TARGET_NOT_EMPTY',
  )
})

test('reconciliation reports changed, missing and unexpected files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-backup-compare-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'storage')
  mkdirSync(source)
  writeFileSync(join(source, 'a.json'), 'a', 'utf8')
  writeFileSync(join(source, 'b.json'), 'b', 'utf8')
  const backupFile = join(root, 'backup.skzbackup')
  createStorageBackup({ sourceDir: source, backupFile, secret: SECRET })
  writeFileSync(join(source, 'a.json'), 'changed', 'utf8')
  rmSync(join(source, 'b.json'))
  writeFileSync(join(source, 'c.json'), 'unexpected', 'utf8')
  assert.deepEqual(compareStorageToBackup({ sourceDir: source, backupFile, secret: SECRET }), {
    identical: false,
    missing: ['b.json'],
    unexpected: ['c.json'],
    changed: ['a.json'],
  })
})

// Аудит PR #131, RCV-05 / SEC-07: копия с работающего сервера может собрать
// журнал и metadata из разных моментов. По умолчанию она не снимается.
function writerSandbox(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'storage')
  mkdirSync(source)
  writeFileSync(join(source, 'room.json'), '{"version":1}\n', 'utf8')
  return { root, source }
}

function writeMarker(source, marker) {
  writeFileSync(join(source, STORAGE_WRITER_MARKER), JSON.stringify(marker), 'utf8')
}

/** pid процесса, который уже завершился. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid
}

test('живой сервер на storage: копия отказывает, а явный обход снимает её с пометкой', (t) => {
  const { root, source } = writerSandbox(t, 'skazanie-backup-live-')
  writeMarker(source, { writer_id: 'live', pid: process.pid, host: hostname(), heartbeat_at: new Date().toISOString() })
  const backupFile = join(root, 'live.skzbackup')

  assert.throws(
    () => createStorageBackup({ sourceDir: source, backupFile, secret: SECRET }),
    (error) => error instanceof BackupError && error.code === 'BACKUP_WRITER_ACTIVE' && error.writer.pid === process.pid,
  )
  assert.equal(existsSync(backupFile), false, 'отказ не оставляет файла копии')

  const forced = createStorageBackup({ sourceDir: source, backupFile, secret: SECRET, allowLiveWriter: true })
  assert.equal(forced.writer.state, 'live')
  assert.equal(forced.consistency, 'not_guaranteed')
  // Отметка — состояние процесса, а не данные: в архив она не попадает.
  assert.equal(forced.file_count, 1)
  const restored = join(root, 'restored')
  restoreStorageBackup({ backupFile, targetDir: restored, secret: SECRET })
  assert.deepEqual(readdirSync(restored), ['room.json'])
  assert.equal(compareStorageToBackup({ sourceDir: source, backupFile, secret: SECRET }).identical, true)
})

test('отметка остановленного сервера не мешает копии', (t) => {
  const { root, source } = writerSandbox(t, 'skazanie-backup-stale-')
  // Та же машина, процесса уже нет (сервер убит без очистки).
  writeMarker(source, { writer_id: 'dead', pid: deadPid(), host: hostname(), heartbeat_at: new Date().toISOString() })
  const afterCrash = createStorageBackup({ sourceDir: source, backupFile: join(root, 'crash.skzbackup'), secret: SECRET })
  assert.equal(afterCrash.writer.state, 'stale')
  assert.equal(afterCrash.writer.reason, 'process_not_running')
  assert.equal(afterCrash.consistency, undefined)

  // Другая машина (контейнер): pid не проверить, решает давность сигнала.
  writeMarker(source, { writer_id: 'remote-old', pid: 1, host: 'container-elsewhere', heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString() })
  const afterStop = createStorageBackup({ sourceDir: source, backupFile: join(root, 'stopped.skzbackup'), secret: SECRET })
  assert.equal(afterStop.writer.state, 'stale')
  assert.equal(afterStop.writer.reason, 'heartbeat_expired')

  // Свежий сигнал с другой машины — сервер жив, копия отказывает.
  writeMarker(source, { writer_id: 'remote-live', pid: 1, host: 'container-elsewhere', heartbeat_at: new Date().toISOString() })
  assert.throws(
    () => createStorageBackup({ sourceDir: source, backupFile: join(root, 'remote.skzbackup'), secret: SECRET }),
    { code: 'BACKUP_WRITER_ACTIVE' },
  )

  // Без отметки сервера нет вовсе.
  rmSync(join(source, STORAGE_WRITER_MARKER))
  const idle = createStorageBackup({ sourceDir: source, backupFile: join(root, 'idle.skzbackup'), secret: SECRET })
  assert.deepEqual(idle.writer, { state: 'absent' })
})

test('сервер объявляет себя писателем и снимает только свою отметку', (t) => {
  const { source } = writerSandbox(t, 'skazanie-backup-claim-')
  const claim = claimStorageWriter(source, { heartbeatMs: 60_000 })
  const live = inspectStorageWriter(source)
  assert.equal(live.state, 'live')
  assert.equal(live.pid, process.pid)
  claim.release()
  assert.equal(inspectStorageWriter(source).state, 'absent')

  // Отметку уже переписал новый сервер на том же каталоге — старый её не трогает.
  const stale = claimStorageWriter(source, { heartbeatMs: 60_000 })
  writeMarker(source, { writer_id: 'newer-server', pid: process.pid, host: hostname(), heartbeat_at: new Date().toISOString() })
  stale.release()
  assert.equal(JSON.parse(readFileSync(join(source, STORAGE_WRITER_MARKER), 'utf8')).writer_id, 'newer-server')
})

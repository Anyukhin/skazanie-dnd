import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BackupError,
  compareStorageToBackup,
  createStorageBackup,
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

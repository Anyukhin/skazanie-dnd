import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIGRATION_ID,
  migrateRoomFile,
  migrateRoomsDirectory,
} from '../server/migrations/001-event-engine.mjs'

function temporaryRooms(t) {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-migration-'))
  const rooms = join(storage, 'rooms')
  mkdirSync(rooms, { recursive: true })
  t.after(() => rmSync(storage, { recursive: true, force: true }))
  return { storage, rooms }
}

test('migration adds event metadata, creates an exact backup, and is idempotent', (t) => {
  const { rooms } = temporaryRooms(t)
  const file = join(rooms, 'RUNE-742.json')
  const originalRoom = {
    version: 59,
    updatedAt: '2026-07-11T17:23:47.876Z',
    state: { sessionCode: 'RUNE-742', campaign: 'Ashes', players: [], messages: [] },
  }
  const original = Buffer.from(JSON.stringify(originalRoom, null, 2), 'utf8')
  writeFileSync(file, original)

  const first = migrateRoomFile(file, {
    rulesetId: 'legacy_5e',
    rulesetVersion: '2014',
    clock: () => new Date('2026-07-11T20:00:00.000Z'),
  })
  assert.equal(first.status, 'migrated')
  assert.deepEqual(readFileSync(first.backup), original)

  const migrated = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(migrated.version, 59, 'legacy room CAS version remains intact')
  assert.equal(migrated.state.campaign, 'Ashes')
  assert.equal(migrated.state.state_version, 0)
  assert.equal(migrated.state.ruleset_id, 'legacy_5e')
  assert.equal(migrated.state.ruleset_version, '2014')
  assert.deepEqual(migrated.state.enabled_rule_packs, ['legacy_5e'])
  assert.deepEqual(migrated.state.enabled_house_rules, [])
  assert.equal(migrated.state.ruleset_locked_at, '2026-07-11T20:00:00.000Z')
  assert.ok(migrated.migrations.includes(MIGRATION_ID))
  assert.equal(migrated.event_engine.legacy_room_version, 59)
  assert.equal(migrated.event_engine.legacy_import_required, true)

  const migratedBytes = readFileSync(file)
  const backupBytes = readFileSync(first.backup)
  const second = migrateRoomFile(file, { clock: () => new Date('2030-01-01T00:00:00.000Z') })
  assert.equal(second.status, 'skipped')
  assert.deepEqual(readFileSync(file), migratedBytes)
  assert.deepEqual(readFileSync(first.backup), backupBytes)
})

test('directory migration isolates corrupt rooms and only writes inside the supplied temp directory', (t) => {
  const { rooms } = temporaryRooms(t)
  writeFileSync(join(rooms, 'GOOD.json'), JSON.stringify({ version: 3, state: { campaign: 'Good' } }))
  writeFileSync(join(rooms, 'BROKEN.json'), '{not json')
  writeFileSync(join(rooms, 'README.txt'), 'ignored')

  const summary = migrateRoomsDirectory(rooms, { clock: () => new Date('2026-07-11T21:00:00.000Z') })
  assert.equal(summary.total, 2)
  assert.equal(summary.migrated, 1)
  assert.equal(summary.failed, 1)
  assert.match(summary.errors[0].error, /Cannot parse room/)

  const good = JSON.parse(readFileSync(join(rooms, 'GOOD.json'), 'utf8'))
  assert.equal(good.state.state_version, 0)
  assert.equal(good.state.ruleset_id, 'srd_5_2_1')
  assert.equal(good.state.ruleset_version, '5.2.1')
  assert.equal(readFileSync(join(rooms, 'BROKEN.json'), 'utf8'), '{not json')
})

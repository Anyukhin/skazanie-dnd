import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export const MIGRATION_ID = '001-event-engine'
export const DEFAULT_RULESET_ID = 'srd_5_2_1'
export const DEFAULT_RULESET_VERSION = '5.2.1'

function nowIso(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('Migration clock returned an invalid date')
  return date.toISOString()
}

function atomicWriteRaw(file, contents, { exclusive = false } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  if (exclusive && existsSync(file)) return false
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, contents)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
    return true
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* best effort */ }
    throw error
  }
}

function validString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function stringList(value, fallback = []) {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : [...fallback]
}

function stateVersion(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Add event-engine metadata to one legacy room without changing its existing
 * room CAS `version`. The domain `state_version` starts at zero; importing the
 * legacy snapshot into FileEventStore creates version one and the
 * LegacyStateImported event.
 */
export function migrateRoomFile(filePath, {
  rulesetId = process.env.DND_DEFAULT_RULESET_ID || DEFAULT_RULESET_ID,
  rulesetVersion = process.env.DND_DEFAULT_RULESET_VERSION || DEFAULT_RULESET_VERSION,
  enabledRulePacks,
  enabledHouseRules = [],
  backupDir,
  clock = () => new Date(),
  dryRun = false,
} = {}) {
  const file = resolve(filePath)
  const original = readFileSync(file)
  let room
  try {
    room = JSON.parse(original.toString('utf8'))
  } catch (error) {
    throw new Error(`Cannot parse room ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isObject(room) || !isObject(room.state)) throw new Error(`Room ${file} must contain an object state`)

  const timestamp = nowIso(clock)
  const resolvedRulesetId = validString(room.state.ruleset_id, validString(rulesetId, DEFAULT_RULESET_ID))
  const resolvedRulesetVersion = validString(room.state.ruleset_version, validString(rulesetVersion, DEFAULT_RULESET_VERSION))
  const migrations = stringList(room.migrations)
  if (!migrations.includes(MIGRATION_ID)) migrations.push(MIGRATION_ID)
  const existingEngine = isObject(room.event_engine) ? room.event_engine : {}

  const migrated = {
    ...room,
    state: {
      ...room.state,
      ruleset_id: resolvedRulesetId,
      ruleset_version: resolvedRulesetVersion,
      enabled_rule_packs: stringList(room.state.enabled_rule_packs, enabledRulePacks ?? [resolvedRulesetId]),
      enabled_house_rules: stringList(room.state.enabled_house_rules, enabledHouseRules),
      ruleset_locked_at: validString(room.state.ruleset_locked_at, timestamp),
      state_version: stateVersion(room.state.state_version),
    },
    migrations,
    event_engine: {
      schema_version: 1,
      legacy_room_version: Number.isSafeInteger(Number(existingEngine.legacy_room_version))
        ? Number(existingEngine.legacy_room_version)
        : stateVersion(room.version),
      legacy_import_required: existingEngine.legacy_import_required ?? true,
      migrated_at: validString(existingEngine.migrated_at, timestamp),
      ...existingEngine,
      migration_id: MIGRATION_ID,
    },
  }
  const encoded = Buffer.from(`${JSON.stringify(migrated, null, 2)}\n`, 'utf8')

  if (Buffer.compare(original, encoded) === 0) {
    return {
      migration_id: MIGRATION_ID,
      file,
      status: 'skipped',
      backup: null,
      ruleset_id: migrated.state.ruleset_id,
      state_version: migrated.state.state_version,
    }
  }

  const backups = resolve(backupDir ?? join(dirname(file), '.backups', MIGRATION_ID))
  const backup = join(backups, `${basename(file)}.bak`)
  if (!dryRun) {
    if (!existsSync(backup)) atomicWriteRaw(backup, original, { exclusive: true })
    atomicWriteRaw(file, encoded)
  }
  return {
    migration_id: MIGRATION_ID,
    file,
    status: dryRun ? 'planned' : 'migrated',
    backup,
    ruleset_id: migrated.state.ruleset_id,
    state_version: migrated.state.state_version,
  }
}

export function migrateRoomsDirectory(roomsDirectory, options = {}) {
  const directory = resolve(roomsDirectory)
  if (!existsSync(directory)) {
    return { migration_id: MIGRATION_ID, directory, total: 0, migrated: 0, skipped: 0, planned: 0, failed: 0, results: [], errors: [] }
  }
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => join(directory, entry.name))
    .sort()
  const results = []
  const errors = []
  for (const file of files) {
    try {
      results.push(migrateRoomFile(file, options))
    } catch (error) {
      errors.push({ file, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    migration_id: MIGRATION_ID,
    directory,
    total: files.length,
    migrated: results.filter((result) => result.status === 'migrated').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    planned: results.filter((result) => result.status === 'planned').length,
    failed: errors.length,
    results,
    errors,
  }
}

export default migrateRoomsDirectory

import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { migrateRoomsDirectory } from './001-event-engine.mjs'

export function runMigrations({
  storageDir = process.env.DND_STORAGE_DIR || join(process.cwd(), 'storage'),
  dryRun = false,
  clock = () => new Date(),
  logger = console,
} = {}) {
  const directory = join(resolve(storageDir), 'rooms')
  const summary = migrateRoomsDirectory(directory, { dryRun, clock })
  logger?.info?.(`[migrations] ${summary.migration_id}: total=${summary.total} migrated=${summary.migrated} skipped=${summary.skipped} planned=${summary.planned} failed=${summary.failed}`)
  for (const failure of summary.errors) logger?.error?.(`[migrations] ${failure.file}: ${failure.error}`)
  return summary
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  const summary = runMigrations({ dryRun: process.argv.includes('--dry-run') })
  if (summary.failed) process.exitCode = 1
}

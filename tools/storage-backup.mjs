import {
  compareStorageToBackup,
  createStorageBackup,
  restoreStorageBackup,
  verifyStorageBackup,
} from '../server/backup-service.mjs'

const [action, first, second] = process.argv.slice(2)
const secret = process.env.DND_BACKUP_KEY

function usage() {
  return 'Usage: node tools/storage-backup.mjs create <storage-dir> <backup-file> | verify <backup-file> | compare <storage-dir> <backup-file> | restore <backup-file> <empty-target-dir>'
}

try {
  let result
  if (action === 'create' && first && second) result = createStorageBackup({ sourceDir: first, backupFile: second, secret })
  else if (action === 'verify' && first && !second) result = verifyStorageBackup({ backupFile: first, secret })
  else if (action === 'compare' && first && second) result = compareStorageToBackup({ sourceDir: first, backupFile: second, secret })
  else if (action === 'restore' && first && second) result = restoreStorageBackup({ backupFile: first, targetDir: second, secret })
  else throw new Error(usage())
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code ?? 'BACKUP_CLI_ERROR', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`)
  process.exitCode = 1
}

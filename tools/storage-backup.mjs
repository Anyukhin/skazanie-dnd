import { join, resolve } from 'node:path'

import {
  compareStorageToBackup,
  createStorageBackup,
  restoreStorageBackup,
  verifyStorageBackup,
} from '../server/backup-service.mjs'

// `pnpm backup -- verify <файл>` из README: часть версий pnpm передаёт сам
// разделитель дальше в скрипт. Без этого фильтра действие терялось и команда
// из документации падала на разборе аргументов.
const argv = process.argv.slice(2).filter((item, index) => !(index === 0 && item === '--'))
const [action, first, second] = argv

// Тот же порядок, что в server/store.mjs: копия снимается ровно с того
// каталога, с которым работает сервер, а не с угаданного пути.
const defaultStorageDir = () => (process.env.DND_STORAGE_DIR
  ? resolve(process.env.DND_STORAGE_DIR)
  : join(process.cwd(), 'storage'))

function defaultBackupFile(now = new Date()) {
  const stamp = now.toISOString().replace(/\.\d+Z$/u, 'Z').replaceAll(':', '-')
  return join(process.cwd(), 'backups', `skazanie-${stamp}.skzbackup`)
}

function usage() {
  return [
    'Использование:',
    '  node tools/storage-backup.mjs                    копия storage в ./backups/skazanie-<дата>.skzbackup',
    '  node tools/storage-backup.mjs create [<storage-dir> [<backup-file>]]',
    '  node tools/storage-backup.mjs verify <backup-file>',
    '  node tools/storage-backup.mjs compare <storage-dir> <backup-file>',
    '  node tools/storage-backup.mjs restore <backup-file> <пустой-каталог>',
    '',
    'Каталог storage по умолчанию — DND_STORAGE_DIR, иначе ./storage.',
    'Всем командам нужна переменная DND_BACKUP_KEY длиной не меньше 32 байт.',
  ].join('\n')
}

function fail(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

// Ошибка сервиса про секрет — английская и говорит только про длину. Здесь
// человек узнаёт, чего именно не хватает и где это заполняется, до того как
// команда успеет создать пустой файл.
function backupSecret() {
  const value = process.env.DND_BACKUP_KEY ?? ''
  const tail = 'Ею шифруется резервная копия: без того же самого значения восстановить её потом нельзя.'
    + ' Задайте переменную в .env (шаблон с комментарием — .env.example) и повторите команду.'
  if (!value) throw fail(`Переменная окружения DND_BACKUP_KEY не задана. ${tail}`, 'BACKUP_SECRET_MISSING')
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw fail(
      `Переменная окружения DND_BACKUP_KEY короче 32 байт (сейчас ${Buffer.byteLength(value, 'utf8')}). ${tail}`,
      'BACKUP_SECRET_TOO_SHORT',
    )
  }
  return value
}

try {
  if (action === 'help' || action === '--help' || action === '-h') {
    process.stdout.write(`${usage()}\n`)
  } else {
    const secret = backupSecret()
    let result
    // Запуск без аргументов — самый частый: снять копию рабочего storage
    // прямо сейчас. Раньше он печатал usage и выходил с 1, поэтому штатной
    // команды бэкапа у проекта фактически не было.
    if (!action || action === 'create') {
      result = createStorageBackup({
        sourceDir: first || defaultStorageDir(),
        backupFile: second || defaultBackupFile(),
        secret,
      })
    } else if (action === 'verify' && first && !second) result = verifyStorageBackup({ backupFile: first, secret })
    else if (action === 'compare' && first && second) result = compareStorageToBackup({ sourceDir: first, backupFile: second, secret })
    else if (action === 'restore' && first && second) result = restoreStorageBackup({ backupFile: first, targetDir: second, secret })
    else throw fail(usage(), 'BACKUP_CLI_USAGE')
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code ?? 'BACKUP_CLI_ERROR', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`)
  process.exitCode = 1
}

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
const rawArgv = process.argv.slice(2).filter((item, index) => !(index === 0 && item === '--'))
// Аудит PR #131, RCV-05: осознанная копия с работающего сервера. Флаг может
// стоять где угодно и в позиционные аргументы не попадает.
const ALLOW_LIVE_FLAG = '--allow-live'
const allowLive = rawArgv.includes(ALLOW_LIVE_FLAG)
const argv = rawArgv.filter((item) => item !== ALLOW_LIVE_FLAG)
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
    '',
    'Копия снимается с остановленного сервера: пока он пишет, журнал событий и',
    'metadata в архиве могут оказаться из разных моментов. Если сервер на этом',
    'storage работает, create отказывает (BACKUP_WRITER_ACTIVE).',
    `  ${ALLOW_LIVE_FLAG}   снять копию с работающего сервера осознанно; согласованность не гарантируется.`,
    '',
    'verify проверяет шифрование и SHA-256 каждого файла, а не целостность кампаний:',
    'архив с живого сервера проходит verify и всё равно может быть несогласованным.',
  ].join('\n')
}

// Отказ сервиса — английский и короткий. Здесь человек узнаёт, кто занимает
// storage, почему это опасно и как поступить.
function writerActiveError(error) {
  const writer = error.writer ?? {}
  return fail([
    `Сервер сейчас работает с этим storage (pid ${writer.pid ?? '?'} на ${writer.host ?? '?'}, последний сигнал ${writer.heartbeat_at ?? '?'}).`,
    'Копия с живого сервера может собрать журнал событий и metadata из разных моментов — архив пройдёт verify, но кампания восстановится несогласованной.',
    `Остановите сервер и повторите команду. Если копия нужна именно сейчас, добавьте ${ALLOW_LIVE_FLAG}: она будет снята, но её согласованность не гарантируется.`,
  ].join(' '), 'BACKUP_WRITER_ACTIVE')
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
      try {
        result = createStorageBackup({
          sourceDir: first || defaultStorageDir(),
          backupFile: second || defaultBackupFile(),
          secret,
          allowLiveWriter: allowLive,
        })
      } catch (error) {
        throw error?.code === 'BACKUP_WRITER_ACTIVE' ? writerActiveError(error) : error
      }
      if (result.writer?.state === 'live') {
        process.stderr.write(`${JSON.stringify({
          ok: true,
          warning: 'BACKUP_LIVE_WRITER',
          message: `Копия снята с работающего сервера по ${ALLOW_LIVE_FLAG}. Её согласованность не гарантируется; verify этого не проверяет.`,
        }, null, 2)}\n`)
      }
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

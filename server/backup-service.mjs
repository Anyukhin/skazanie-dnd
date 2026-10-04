import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export const BACKUP_SCHEMA_VERSION = 1
export const BACKUP_FORMAT = 'skazanie:encrypted-storage-backup-v1'
const AAD = Buffer.from(BACKUP_FORMAT, 'utf8')
const MAX_FILES = 100_000
const MAX_FILE_BYTES = 128 * 1024 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

/**
 * Аудит PR #131, RCV-05: отметка живого сервера в корне storage.
 *
 * Копия снимается файл за файлом, а commit журнала пишет событие, снимок и
 * metadata разными шагами. Пока сервер пишет, копия может собрать журнал одного
 * момента и metadata другого: архив честно зашифрован и проходит `verify`, но
 * восстановленная кампания несогласована. Поэтому обещанный режим копии —
 * остановленный сервер, и это проверяется, а не только описано.
 *
 * Сервер объявляет себя файлом-отметкой (`claimStorageWriter`) и раз в
 * `WRITER_HEARTBEAT_MS` обновляет в нём время. Копия (`createStorageBackup`)
 * по умолчанию отказывает, пока отметка живая. Устаревшей отметка считается,
 * если время не обновлялось дольше `WRITER_STALE_MS` (сервер упал, контейнер
 * убит) либо если на этой же машине процесса с её pid уже нет. Отметка видит
 * только игровой сервер, а не любой процесс, пишущий в каталог; в архив она не
 * попадает.
 */
export const STORAGE_WRITER_MARKER = '.server-writer.json'
const WRITER_HEARTBEAT_MS = 60_000
const WRITER_STALE_MS = 5 * 60_000

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: процесс есть, но чужой — он жив.
    return error?.code === 'EPERM'
  }
}

/**
 * Объявляет текущий процесс писателем storage. Возвращает `release`, который
 * удаляет отметку, только если она всё ещё своя: новый сервер на том же
 * каталоге мог уже переписать её.
 */
export function claimStorageWriter(storageDir, { heartbeatMs = WRITER_HEARTBEAT_MS, now = () => new Date() } = {}) {
  const file = join(resolve(String(storageDir ?? '')), STORAGE_WRITER_MARKER)
  const identity = {
    schema_version: 1,
    writer_id: randomUUID(),
    pid: process.pid,
    host: hostname(),
    started_at: now().toISOString(),
  }
  const write = () => atomicWrite(file, Buffer.from(`${JSON.stringify({ ...identity, heartbeat_at: now().toISOString() }, null, 2)}\n`, 'utf8'))
  write()
  const timer = setInterval(() => {
    // Пропуск такта не опасен: отметка устареет только после нескольких подряд.
    try { write() } catch { /* следующий такт повторит */ }
  }, heartbeatMs)
  timer.unref?.()
  let released = false
  const release = () => {
    if (released) return
    released = true
    clearInterval(timer)
    try {
      if (JSON.parse(readFileSync(file, 'utf8'))?.writer_id === identity.writer_id) unlinkSync(file)
    } catch { /* отметки уже нет или она нечитаема — оставляем как есть */ }
  }
  return { file, writer_id: identity.writer_id, release }
}

/**
 * Состояние отметки писателя: `absent` — сервера нет, `stale` — отметка
 * осталась от остановленного сервера, `live` — сервер пишет прямо сейчас.
 */
export function inspectStorageWriter(storageDir, {
  now = () => Date.now(),
  host = hostname(),
  isProcessAlive = processAlive,
  staleAfterMs = WRITER_STALE_MS,
} = {}) {
  const file = join(resolve(String(storageDir ?? '')), STORAGE_WRITER_MARKER)
  if (!existsSync(file)) return { state: 'absent', marker_file: file }
  let marker = null
  try { marker = JSON.parse(readFileSync(file, 'utf8')) } catch { /* нечитаемую отметку судим по времени файла */ }
  const declared = Date.parse(String(marker?.heartbeat_at ?? ''))
  const heartbeat = Number.isFinite(declared) ? declared : statSync(file).mtimeMs
  const pid = Number(marker?.pid)
  const details = {
    marker_file: file,
    pid: Number.isSafeInteger(pid) ? pid : null,
    host: marker?.host ?? null,
    started_at: marker?.started_at ?? null,
    heartbeat_at: new Date(heartbeat).toISOString(),
  }
  if (now() - heartbeat > staleAfterMs) return { state: 'stale', reason: 'heartbeat_expired', ...details }
  if (marker?.host === host && Number.isSafeInteger(pid) && pid > 0 && !isProcessAlive(pid)) {
    return { state: 'stale', reason: 'process_not_running', ...details }
  }
  return { state: 'live', ...details }
}

export class BackupError extends Error {
  constructor(message, code = 'BACKUP_ERROR', details = {}) {
    super(message)
    this.name = 'BackupError'
    this.code = code
    Object.assign(this, details)
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function requireSecret(secret) {
  const value = String(secret ?? '')
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new BackupError('Backup secret must contain at least 32 UTF-8 bytes', 'BACKUP_SECRET_TOO_SHORT')
  }
  return value
}

function safeRelativePath(value) {
  const path = String(value ?? '').replaceAll('\\', '/')
  if (!path || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new BackupError(`Unsafe backup entry path: ${value}`, 'BACKUP_PATH_INVALID')
  }
  return path
}

function safeChild(rootDir, relativePath) {
  const root = resolve(rootDir)
  const path = safeRelativePath(relativePath)
  const absolute = resolve(root, path)
  const rel = relative(root, absolute)
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || isAbsolute(rel)) {
    throw new BackupError(`Backup entry escapes target: ${relativePath}`, 'BACKUP_PATH_INVALID')
  }
  return absolute
}

function collectFiles(rootDir, directory = rootDir, prefix = '') {
  const result = []
  for (const name of readdirSync(directory).sort()) {
    if (name.endsWith('.tmp') || name.includes('.tmp.')) continue
    // Отметка живого сервера — состояние процесса, а не данные: восстановленный
    // каталог не должен выглядеть занятым чужим pid.
    if (!prefix && name === STORAGE_WRITER_MARKER) continue
    const absolute = join(directory, name)
    const relativePath = prefix ? `${prefix}/${name}` : name
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) throw new BackupError(`Symbolic links are not allowed in backups: ${relativePath}`, 'BACKUP_SYMLINK_FORBIDDEN')
    if (stat.isDirectory()) result.push(...collectFiles(rootDir, absolute, relativePath))
    else if (stat.isFile()) result.push({ absolute, path: safeRelativePath(relativePath), size: stat.size })
    else throw new BackupError(`Unsupported filesystem entry: ${relativePath}`, 'BACKUP_ENTRY_UNSUPPORTED')
    if (result.length > MAX_FILES) throw new BackupError(`Backup exceeds ${MAX_FILES} files`, 'BACKUP_LIMIT_EXCEEDED')
  }
  return result
}

function atomicWrite(file, bytes) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, bytes)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* best effort */ }
    throw error
  }
}

function encryptedEnvelope(payload, secret) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(requireSecret(secret), salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    schema_version: BACKUP_SCHEMA_VERSION,
    format: BACKUP_FORMAT,
    kdf: { name: 'scrypt', salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    ciphertext: ciphertext.toString('base64'),
  }
}

function decodeEnvelope(input, secret) {
  let envelope
  try {
    envelope = typeof input === 'string' || Buffer.isBuffer(input) ? JSON.parse(String(input)) : input
  } catch {
    throw new BackupError('Backup envelope is not valid JSON', 'BACKUP_ENVELOPE_INVALID')
  }
  if (envelope?.schema_version !== BACKUP_SCHEMA_VERSION || envelope?.format !== BACKUP_FORMAT
    || envelope?.kdf?.name !== 'scrypt' || envelope?.cipher?.name !== 'aes-256-gcm') {
    throw new BackupError('Backup envelope has an unsupported format', 'BACKUP_ENVELOPE_INVALID')
  }
  try {
    const salt = Buffer.from(envelope.kdf.salt, 'base64')
    const iv = Buffer.from(envelope.cipher.iv, 'base64')
    const tag = Buffer.from(envelope.cipher.tag, 'base64')
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error('invalid envelope bytes')
    const key = scryptSync(requireSecret(secret), salt, 32)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'))
  } catch (error) {
    if (error instanceof BackupError) throw error
    throw new BackupError('Backup authentication or decryption failed', 'BACKUP_AUTHENTICATION_FAILED')
  }
}

function validatePayload(payload) {
  if (payload?.schema_version !== BACKUP_SCHEMA_VERSION || payload?.format !== BACKUP_FORMAT || !Array.isArray(payload.files)) {
    throw new BackupError('Decrypted backup payload has an unsupported shape', 'BACKUP_PAYLOAD_INVALID')
  }
  if (payload.files.length > MAX_FILES) throw new BackupError('Backup contains too many files', 'BACKUP_LIMIT_EXCEEDED')
  const seen = new Set()
  let totalBytes = 0
  for (const entry of payload.files) {
    const path = safeRelativePath(entry.path)
    if (seen.has(path)) throw new BackupError(`Duplicate backup entry: ${path}`, 'BACKUP_PAYLOAD_INVALID')
    seen.add(path)
    const bytes = Buffer.from(String(entry.data ?? ''), 'base64')
    if (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0 || entry.size_bytes > MAX_FILE_BYTES || bytes.length !== entry.size_bytes) {
      throw new BackupError(`Invalid size for backup entry ${path}`, 'BACKUP_PAYLOAD_INVALID')
    }
    if (!/^[a-f0-9]{64}$/u.test(String(entry.sha256 ?? '')) || sha256(bytes) !== entry.sha256) {
      throw new BackupError(`Hash mismatch for backup entry ${path}`, 'BACKUP_HASH_MISMATCH')
    }
    totalBytes += bytes.length
    if (totalBytes > MAX_TOTAL_BYTES) throw new BackupError('Backup exceeds the total size limit', 'BACKUP_LIMIT_EXCEEDED')
  }
  if (Number(payload.total_bytes) !== totalBytes || Number(payload.file_count) !== payload.files.length) {
    throw new BackupError('Backup manifest totals do not match its entries', 'BACKUP_PAYLOAD_INVALID')
  }
  return { payload, totalBytes }
}

function readVerifiedBackup(backupFile, secret) {
  let source
  try {
    source = readFileSync(resolve(backupFile))
  } catch {
    throw new BackupError(`Backup file does not exist: ${backupFile}`, 'BACKUP_NOT_FOUND')
  }
  return validatePayload(decodeEnvelope(source, secret)).payload
}

export function createStorageBackup({
  sourceDir,
  backupFile,
  secret,
  now = () => new Date(),
  allowLiveWriter = false,
} = {}) {
  const source = resolve(String(sourceDir ?? ''))
  const output = resolve(String(backupFile ?? ''))
  if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new BackupError(`Storage directory does not exist: ${source}`, 'BACKUP_SOURCE_INVALID')
  const relativeOutput = relative(source, output)
  if (relativeOutput && !relativeOutput.startsWith('..') && !isAbsolute(relativeOutput)) {
    throw new BackupError('Backup file must be outside the storage directory', 'BACKUP_TARGET_INSIDE_SOURCE')
  }
  if (existsSync(output)) throw new BackupError(`Backup file already exists: ${output}`, 'BACKUP_ALREADY_EXISTS')
  // Аудит PR #131, RCV-05: копия с живого сервера может быть несогласованной,
  // поэтому по умолчанию она не снимается. Осознанный обход — `allowLiveWriter`.
  const writerActive = (writer) => new BackupError(
    `Storage is in use by a running server (pid ${writer.pid ?? '?'} on ${writer.host ?? '?'}); stop it before taking a backup`,
    'BACKUP_WRITER_ACTIVE',
    { writer },
  )
  const writer = inspectStorageWriter(source)
  if (writer.state === 'live' && !allowLiveWriter) throw writerActive(writer)
  const files = collectFiles(source)
  let totalBytes = 0
  const entries = files.map((file) => {
    if (file.size > MAX_FILE_BYTES) throw new BackupError(`File exceeds backup limit: ${file.path}`, 'BACKUP_LIMIT_EXCEEDED')
    const bytes = readFileSync(file.absolute)
    totalBytes += bytes.length
    if (totalBytes > MAX_TOTAL_BYTES) throw new BackupError('Backup exceeds the total size limit', 'BACKUP_LIMIT_EXCEEDED')
    return { path: file.path, size_bytes: bytes.length, sha256: sha256(bytes), data: bytes.toString('base64') }
  })
  // Сервер мог подняться, пока файлы читались: такая копия уже не с покоя.
  if (!allowLiveWriter) {
    const after = inspectStorageWriter(source)
    if (after.state === 'live') throw writerActive(after)
  }
  const timestamp = now()
  const createdAt = (timestamp instanceof Date ? timestamp : new Date(timestamp)).toISOString()
  const payload = {
    schema_version: BACKUP_SCHEMA_VERSION,
    format: BACKUP_FORMAT,
    created_at: createdAt,
    file_count: entries.length,
    total_bytes: totalBytes,
    files: entries,
  }
  atomicWrite(output, Buffer.from(`${JSON.stringify(encryptedEnvelope(payload, secret), null, 2)}\n`, 'utf8'))
  return {
    backup_file: output,
    created_at: createdAt,
    file_count: entries.length,
    total_bytes: totalBytes,
    encrypted: true,
    // Что знала копия о сервере в момент снятия. `live` бывает только при
    // явном обходе, и тогда согласованность архива не гарантируется.
    writer: writer.state === 'absent'
      ? { state: 'absent' }
      : { state: writer.state, ...(writer.reason ? { reason: writer.reason } : {}), pid: writer.pid, host: writer.host, heartbeat_at: writer.heartbeat_at },
    ...(writer.state === 'live' ? { consistency: 'not_guaranteed' } : {}),
  }
}

export function verifyStorageBackup({ backupFile, secret } = {}) {
  const payload = readVerifiedBackup(backupFile, secret)
  return {
    backup_file: resolve(backupFile),
    created_at: payload.created_at,
    file_count: payload.file_count,
    total_bytes: payload.total_bytes,
    encrypted: true,
    verified: true,
  }
}

export function compareStorageToBackup({ sourceDir, backupFile, secret } = {}) {
  const source = resolve(String(sourceDir ?? ''))
  const payload = readVerifiedBackup(backupFile, secret)
  const expected = new Map(payload.files.map((entry) => [entry.path, entry]))
  const actualFiles = existsSync(source) ? collectFiles(source) : []
  const actual = new Map(actualFiles.map((entry) => [entry.path, entry]))
  const missing = [...expected.keys()].filter((path) => !actual.has(path))
  const unexpected = [...actual.keys()].filter((path) => !expected.has(path))
  const changed = [...expected.entries()].filter(([path, entry]) => {
    const current = actual.get(path)
    return current && (current.size !== entry.size_bytes || sha256File(current.absolute) !== entry.sha256)
  }).map(([path]) => path)
  return { identical: !missing.length && !unexpected.length && !changed.length, missing, unexpected, changed }
}

function sha256File(file) {
  return sha256(readFileSync(file))
}

export function restoreStorageBackup({
  backupFile,
  targetDir,
  secret,
} = {}) {
  const payload = readVerifiedBackup(backupFile, secret)
  const target = resolve(String(targetDir ?? ''))
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new BackupError('Restore target must be absent or empty', 'RESTORE_TARGET_NOT_EMPTY')
  }
  mkdirSync(target, { recursive: true })
  for (const entry of payload.files) {
    const output = safeChild(target, entry.path)
    mkdirSync(dirname(output), { recursive: true })
    const descriptor = openSync(output, 'wx', 0o600)
    try {
      writeFileSync(descriptor, Buffer.from(entry.data, 'base64'))
    } finally {
      closeSync(descriptor)
    }
  }
  const reconciliation = compareStorageToBackup({ sourceDir: target, backupFile, secret })
  if (!reconciliation.identical) throw new BackupError('Restored storage failed reconciliation', 'RESTORE_RECONCILIATION_FAILED', reconciliation)
  return {
    target_dir: target,
    file_count: payload.file_count,
    total_bytes: payload.total_bytes,
    restored: true,
    reconciliation,
  }
}

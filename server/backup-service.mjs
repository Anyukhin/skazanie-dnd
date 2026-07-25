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
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export const BACKUP_SCHEMA_VERSION = 1
export const BACKUP_FORMAT = 'skazanie:encrypted-storage-backup-v1'
const AAD = Buffer.from(BACKUP_FORMAT, 'utf8')
const MAX_FILES = 100_000
const MAX_FILE_BYTES = 128 * 1024 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

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
} = {}) {
  const source = resolve(String(sourceDir ?? ''))
  const output = resolve(String(backupFile ?? ''))
  if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new BackupError(`Storage directory does not exist: ${source}`, 'BACKUP_SOURCE_INVALID')
  const relativeOutput = relative(source, output)
  if (relativeOutput && !relativeOutput.startsWith('..') && !isAbsolute(relativeOutput)) {
    throw new BackupError('Backup file must be outside the storage directory', 'BACKUP_TARGET_INSIDE_SOURCE')
  }
  if (existsSync(output)) throw new BackupError(`Backup file already exists: ${output}`, 'BACKUP_ALREADY_EXISTS')
  const files = collectFiles(source)
  let totalBytes = 0
  const entries = files.map((file) => {
    if (file.size > MAX_FILE_BYTES) throw new BackupError(`File exceeds backup limit: ${file.path}`, 'BACKUP_LIMIT_EXCEEDED')
    const bytes = readFileSync(file.absolute)
    totalBytes += bytes.length
    if (totalBytes > MAX_TOTAL_BYTES) throw new BackupError('Backup exceeds the total size limit', 'BACKUP_LIMIT_EXCEEDED')
    return { path: file.path, size_bytes: bytes.length, sha256: sha256(bytes), data: bytes.toString('base64') }
  })
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

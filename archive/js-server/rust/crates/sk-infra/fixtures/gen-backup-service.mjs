// Эталон `server/backup-service.mjs` для `tests/backup_service_fixture.rs`.
//
// Секрет ниже выдуман только для эталона — это не ключ хранилища.
//
//   node rust/crates/sk-infra/fixtures/gen-backup-service.mjs
//     снимает копию тестового каталога JS-ом: fixtures/backup-js.skzbackup и
//     манифест fixtures/backup-js.json (файлы, порядок в архиве, итог создания);
//   node rust/crates/sk-infra/fixtures/gen-backup-service.mjs verify <копия> <манифест>
//     проверяет и восстанавливает копию (например, снятую Rust-ом) и печатает
//     JSON-итог в stdout; код выхода 0 — копия совпала с манифестом.
import { createDecipheriv, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BACKUP_FORMAT,
  STORAGE_WRITER_MARKER,
  compareStorageToBackup,
  createStorageBackup,
  restoreStorageBackup,
  verifyStorageBackup,
} from '../../../../server/backup-service.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const SECRET = 'fixture-only-backup-secret-not-a-real-key-0123456789'

const blob = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 256))
const FILES = [
  ['auth.json', Buffer.from('{"users":[{"id":"u1"}]}\n', 'utf8')],
  ['engine/campaign-a/events/000001.json', Buffer.from('{"event_type":"SceneAdvanced"}\n', 'utf8')],
  ['engine/Кампания/заметки.txt', Buffer.from('Привет, мир\n', 'utf8')],
  ['maps/blob.bin', blob],
  ['empty.txt', Buffer.alloc(0)],
  ['nested/deep/a/b/c.json', Buffer.from('{"deep":true}', 'utf8')],
  ['B.txt', Buffer.from('B', 'utf8')],
  ['a.txt', Buffer.from('a', 'utf8')],
  ['Ä.txt', Buffer.from('umlaut', 'utf8')],
  ['engine/room.json', Buffer.from('{"version":3}\n', 'utf8')],
]
// Пропускаются копией: временные файлы и отметка сервера в корне.
const SKIPPED = [
  ['skip.tmp', 'x'],
  ['engine/a.tmp.1', 'y'],
]
const MARKER = { schema_version: 1, writer_id: 'fixture-old-server', pid: 4242, host: 'fixture-host-elsewhere', started_at: '2020-01-01T00:00:00.000Z', heartbeat_at: '2020-01-01T00:00:00.000Z' }

function decryptPayload(file, secret) {
  const envelope = JSON.parse(readFileSync(file, 'utf8'))
  const key = scryptSync(secret, Buffer.from(envelope.kdf.salt, 'base64'), 32)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.cipher.iv, 'base64'))
  decipher.setAAD(Buffer.from(BACKUP_FORMAT, 'utf8'))
  decipher.setAuthTag(Buffer.from(envelope.cipher.tag, 'base64'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'))
}

function generate() {
  const root = mkdtempSync(join(tmpdir(), 'sk-infra-backup-'))
  const source = join(root, 'storage')
  for (const [path, bytes] of [...FILES, ...SKIPPED]) {
    mkdirSync(dirname(join(source, path)), { recursive: true })
    writeFileSync(join(source, path), bytes)
  }
  writeFileSync(join(source, STORAGE_WRITER_MARKER), JSON.stringify(MARKER), 'utf8')
  const backupFile = join(here, 'backup-js.skzbackup')
  rmSync(backupFile, { force: true })
  const created = createStorageBackup({ sourceDir: source, backupFile, secret: SECRET, now: () => new Date('2026-10-14T00:00:00.000Z') })
  const payload = decryptPayload(backupFile, SECRET)
  delete created.backup_file
  const manifest = {
    secret: SECRET,
    marker: MARKER,
    files: FILES.map(([path, bytes]) => ({ path, data: bytes.toString('base64') })),
    skipped: SKIPPED.map(([path, text]) => ({ path, data: Buffer.from(text, 'utf8').toString('base64') })),
    payload_paths: payload.files.map((entry) => entry.path),
    created,
  }
  writeFileSync(join(here, 'backup-js.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  rmSync(root, { recursive: true, force: true })
  console.log(`backup-js: ${created.file_count} файлов, ${created.total_bytes} байт`)
}

function verify(backupFile, manifestFile) {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const report = { ok: true, problems: [] }
  const problem = (text) => { report.ok = false; report.problems.push(text) }
  try {
    report.verify = verifyStorageBackup({ backupFile, secret: manifest.secret })
    report.payload_paths = decryptPayload(backupFile, manifest.secret).files.map((entry) => entry.path)
    if (JSON.stringify(report.payload_paths) !== JSON.stringify(manifest.payload_paths)) problem('порядок файлов в архиве не тот')
    const root = mkdtempSync(join(tmpdir(), 'sk-infra-backup-verify-'))
    const target = join(root, 'restored')
    report.restore = restoreStorageBackup({ backupFile, targetDir: target, secret: manifest.secret })
    for (const entry of manifest.files) {
      const file = join(target, entry.path)
      if (!existsSync(file)) problem(`нет файла ${entry.path}`)
      else if (readFileSync(file).toString('base64') !== entry.data) problem(`другое содержимое ${entry.path}`)
    }
    for (const entry of manifest.skipped) if (existsSync(join(target, entry.path))) problem(`лишний файл ${entry.path}`)
    if (existsSync(join(target, STORAGE_WRITER_MARKER))) problem('отметка сервера попала в архив')
    report.compare = compareStorageToBackup({ sourceDir: target, backupFile, secret: manifest.secret })
    if (!report.compare.identical) problem('сверка не прошла')
    try {
      verifyStorageBackup({ backupFile, secret: `${manifest.secret}-wrong` })
      problem('чужой секрет принят')
    } catch (error) {
      if (error.code !== 'BACKUP_AUTHENTICATION_FAILED') problem(`чужой секрет: ${error.code}`)
    }
    rmSync(root, { recursive: true, force: true })
  } catch (error) {
    problem(`${error.code ?? error.name}: ${error.message}`)
  }
  console.log(JSON.stringify(report))
  process.exitCode = report.ok ? 0 : 1
}

if (process.argv[2] === 'verify') verify(process.argv[3], process.argv[4])
else generate()

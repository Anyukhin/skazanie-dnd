// Проверка совместимости архива Rust с читающим модулем JS на эталоне.
import assert from 'node:assert/strict'
import { createDecipheriv, scryptSync } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BACKUP_FORMAT, STORAGE_WRITER_MARKER, compareStorageToBackup, restoreStorageBackup, verifyStorageBackup } from '../../../../server/backup-service.mjs'

const [backupFile, manifestFile, targetDir] = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
const options = { backupFile, secret: manifest.secret }

const verified = verifyStorageBackup(options)
const envelope = JSON.parse(readFileSync(backupFile, 'utf8'))
const key = scryptSync(manifest.secret, Buffer.from(envelope.kdf.salt, 'base64'), 32)
const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.cipher.iv, 'base64'))
decipher.setAAD(Buffer.from(BACKUP_FORMAT, 'utf8'))
decipher.setAuthTag(Buffer.from(envelope.cipher.tag, 'base64'))
const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'))
const payloadPaths = payload.files.map((entry) => entry.path)
assert.deepEqual(payloadPaths, manifest.payload_paths)

restoreStorageBackup({ ...options, targetDir })
for (const entry of manifest.files) {
  assert.equal(readFileSync(join(targetDir, entry.path)).toString('base64'), entry.data, entry.path)
}
for (const path of [...manifest.skipped.map((entry) => entry.path), STORAGE_WRITER_MARKER]) {
  assert.equal(existsSync(join(targetDir, path)), false, path)
}
assert.equal(compareStorageToBackup({ ...options, sourceDir: targetDir }).identical, true)
assert.throws(() => verifyStorageBackup({ ...options, secret: manifest.secret + '-wrong' }), { code: 'BACKUP_AUTHENTICATION_FAILED' })
console.log(JSON.stringify({ ok: true, payload_paths: payloadPaths, verify: verified }))

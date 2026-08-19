import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../tools/storage-backup.mjs', import.meta.url))
const SECRET = 'test-only-backup-secret-with-more-than-32-bytes'

// Каталог всегда временный: рабочий storage проекта тест не открывает.
function sandbox(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'storage', 'engine'), { recursive: true })
  writeFileSync(join(root, 'storage', 'engine', 'room.json'), '{"version":3}\n', 'utf8')
  return root
}

function runCli(args, { cwd, key }) {
  const env = { ...process.env }
  delete env.DND_STORAGE_DIR
  delete env.DND_BACKUP_KEY
  if (key) env.DND_BACKUP_KEY = key
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' })
}

test('запуск без аргументов создаёт копию storage в ./backups с датой в имени', (t) => {
  const root = sandbox(t, 'skazanie-backup-cli-')

  const created = runCli([], { cwd: root, key: SECRET })
  assert.equal(created.status, 0, created.stderr)
  const result = JSON.parse(created.stdout)
  assert.equal(result.file_count, 1)
  assert.equal(result.encrypted, true)
  assert.match(basename(result.backup_file), /^skazanie-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.skzbackup$/u)
  assert.ok(existsSync(join(root, 'backups', basename(result.backup_file))))

  // Форма из README: `pnpm backup -- verify <файл>`. Разделитель до скрипта
  // доходит не во всех версиях pnpm, поэтому обе формы обязаны работать.
  for (const args of [['verify', result.backup_file], ['--', 'verify', result.backup_file]]) {
    const verified = runCli(args, { cwd: root, key: SECRET })
    assert.equal(verified.status, 0, verified.stderr)
    assert.equal(JSON.parse(verified.stdout).verified, true)
  }
})

test('без DND_BACKUP_KEY или с коротким ключом команда падает и объясняет, чего не хватает', (t) => {
  const root = sandbox(t, 'skazanie-backup-cli-key-')

  const missing = runCli([], { cwd: root, key: '' })
  assert.equal(missing.status, 1)
  const missingError = JSON.parse(missing.stderr)
  assert.equal(missingError.code, 'BACKUP_SECRET_MISSING')
  assert.match(missingError.error, /DND_BACKUP_KEY/u)
  assert.match(missingError.error, /\.env\.example/u)

  const short = runCli([], { cwd: root, key: 'too-short-key' })
  assert.equal(short.status, 1)
  assert.equal(JSON.parse(short.stderr).code, 'BACKUP_SECRET_TOO_SHORT')

  // Ни одна из неудачных попыток не оставила после себя файла копии.
  assert.equal(existsSync(join(root, 'backups')), false)
})

test('help печатает подсказку в stdout и выходит с нулём', (t) => {
  const root = sandbox(t, 'skazanie-backup-cli-help-')
  const help = runCli(['--help'], { cwd: root, key: '' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /storage-backup\.mjs create/u)
  assert.match(help.stdout, /DND_BACKUP_KEY/u)
})

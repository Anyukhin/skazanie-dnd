import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { STORAGE_WRITER_MARKER } from '../server/backup-service.mjs'
import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

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
  assert.match(help.stdout, /--allow-live/u)
})

// Аудит PR #131, RCV-05: копия с работающего сервера по умолчанию не снимается.
test('живой сервер на storage: create отказывает, --allow-live снимает копию с предупреждением', (t) => {
  const root = sandbox(t, 'skazanie-backup-cli-live-')
  writeFileSync(join(root, 'storage', STORAGE_WRITER_MARKER), JSON.stringify({
    writer_id: 'cli-live', pid: process.pid, host: hostname(), heartbeat_at: new Date().toISOString(),
  }), 'utf8')

  const refused = runCli([], { cwd: root, key: SECRET })
  assert.equal(refused.status, 1, refused.stdout)
  const error = JSON.parse(refused.stderr)
  assert.equal(error.code, 'BACKUP_WRITER_ACTIVE')
  assert.match(error.error, /Остановите сервер/u)
  assert.match(error.error, /--allow-live/u)
  assert.equal(existsSync(join(root, 'backups')), false, 'отказ не оставляет файла копии')

  // Флаг стоит после разделителя pnpm и перед действием — позиционные не сбиваются.
  const forced = runCli(['--', '--allow-live', 'create'], { cwd: root, key: SECRET })
  assert.equal(forced.status, 0, forced.stderr)
  const result = JSON.parse(forced.stdout)
  assert.equal(result.writer.state, 'live')
  assert.equal(result.consistency, 'not_guaranteed')
  assert.equal(result.file_count, 1, 'отметка сервера в архив не попадает')
  const warning = JSON.parse(forced.stderr)
  assert.equal(warning.warning, 'BACKUP_LIVE_WRITER')
  assert.match(warning.message, /не гарантируется/u)
})

test('настоящий сервер занимает storage, пока работает, и освобождает после остановки', { timeout: runnerTimeout(60_000) }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-backup-cli-server-'))
  const storage = join(root, 'storage')
  let logs = ''
  let child = null
  t.after(async () => {
    if (child && child.exitCode == null && child.signalCode == null) {
      await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
    }
    rmSync(root, { recursive: true, force: true })
  })
  const port = await freePort()
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: 'backup-cli-server-setup',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { logs += String(chunk) })
  child.stderr.on('data', (chunk) => { logs += String(chunk) })
  let healthy = false
  for (let attempt = 0; attempt < 200 && !healthy; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Тестовый сервер завершился\n${logs}`)
    try { healthy = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok } catch { /* сервер ещё запускается */ }
    if (!healthy) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(healthy, `Тестовый сервер не запустился\n${logs}`)

  const busy = runCli(['create', storage, join(root, 'busy.skzbackup')], { cwd: root, key: SECRET })
  assert.equal(busy.status, 1, busy.stdout)
  assert.equal(JSON.parse(busy.stderr).code, 'BACKUP_WRITER_ACTIVE')
  assert.equal(existsSync(join(root, 'busy.skzbackup')), false)

  // Штатная остановка снимает отметку; принудительная (Windows) оставляет
  // отметку мёртвого процесса, и она распознаётся устаревшей.
  await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
  const idle = runCli(['create', storage, join(root, 'idle.skzbackup')], { cwd: root, key: SECRET })
  assert.equal(idle.status, 0, idle.stderr)
  assert.ok(['absent', 'stale'].includes(JSON.parse(idle.stdout).writer.state), idle.stdout)
})

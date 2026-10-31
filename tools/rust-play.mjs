#!/usr/bin/env node
// Запуск Rust-сервера для ручной игры рядом с основным (JS или Docker на 8787):
// собирает выпускной бинарь и клиент, поднимает сервер на своём порту и своём
// хранилище. Рабочее storage/ не читает и не пишет.
//
//   node tools/rust-play.mjs                 порт 8788, хранилище tmp/rust-play/storage
//   node tools/rust-play.mjs --offline       без модели (пустой ROUTERAI_API_KEY)
//   node tools/rust-play.mjs --port 8790 --storage tmp/rust-play/second
//   node tools/rust-play.mjs --no-build      без пересборки бинаря и клиента
//
// Ключ модели, токен первого админа и прочее берутся из .env, как у JS-сервера;
// значения не печатаются. Порт 8787 занят основной игрой — на нём не запускается.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

if (flag('--help') || flag('-h')) {
  console.log('node tools/rust-play.mjs [--port 8788] [--storage tmp/rust-play/storage] [--offline] [--no-build] [--client]')
  process.exit(0)
}

const port = Number(option('--port', '8788'))
if (!Number.isInteger(port) || port <= 0 || port > 65535 || port === 8787) {
  console.error('Порт должен быть числом 1–65535 и не 8787 (там основная игра).')
  process.exit(2)
}
const storage = resolve(root, option('--storage', 'tmp/rust-play/storage'))
if (storage === resolve(root, 'storage')) {
  console.error('Рабочее storage/ этим запуском не открывается: укажите другой каталог.')
  process.exit(2)
}

// cargo и компоновщик MinGW на машине владельца лежат вне PATH.
const extraPath = [join(homedir(), '.cargo', 'bin'), join(homedir(), '.cargo', 'mingw64-root', 'mingw64', 'bin')].filter(existsSync)
const env = { ...process.env, PATH: [...extraPath, process.env.PATH].join(delimiter) }

const run = (command, commandArgs, cwd) => {
  const result = spawnSync(command, commandArgs, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' && command === 'cargo' })
  if (result.status !== 0) {
    console.error(`Не удалось: ${command} ${commandArgs.join(' ')}`)
    process.exit(result.status ?? 1)
  }
}

const newestMtime = (dir) => {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs)
  }
  return newest
}

const binary = join(root, 'rust', 'target', 'release', process.platform === 'win32' ? 'skazanie-server.exe' : 'skazanie-server')
if (!flag('--no-build')) {
  env.CARGO_BUILD_JOBS ??= '4'
  run('cargo', ['build', '--release', '--locked', '-p', 'sk-server', '--bin', 'skazanie-server'], join(root, 'rust'))
  const distIndex = join(root, 'dist', 'index.html')
  if (flag('--client') || !existsSync(distIndex) || statSync(distIndex).mtimeMs < newestMtime(join(root, 'src'))) {
    // Только vite: pnpm может не быть в PATH, а проверка типов игре не нужна.
    run(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], root)
  }
}
if (!existsSync(binary)) {
  console.error(`Нет бинаря ${binary}: запустите без --no-build.`)
  process.exit(1)
}

// Smart App Control на Windows не даёт запустить свежую неподписанную сборку
// по её хешу; запускается копия с уникальным хвостом — только своя сборка
// (решение владельца 2026-10-21).
let executable = binary
if (process.platform === 'win32') {
  const binDir = join(root, 'tmp', 'rust-play', 'bin')
  mkdirSync(binDir, { recursive: true })
  // Прежние копии; занятая другим запуском остаётся.
  for (const old of readdirSync(binDir)) {
    try { rmSync(join(binDir, old)) } catch {}
  }
  executable = join(binDir, `skazanie-server-${Date.now()}.exe`)
  copyFileSync(binary, executable)
  appendFileSync(executable, `sacpad${Date.now()}${Math.random()}`)
}

mkdirSync(storage, { recursive: true })
const serverEnv = { ...env, AGENT_PORT: String(port), AGENT_HOST: option('--host', '127.0.0.1'), DND_STORAGE_DIR: storage, DND_DATA_DIR: root }
if (flag('--offline')) serverEnv.ROUTERAI_API_KEY = ''
console.log(`Rust-сервер: http://127.0.0.1:${port}  хранилище: ${storage}${flag('--offline') ? '  без модели' : ''}`)
console.log('Остановить — Ctrl+C.')
const server = spawn(executable, [], { cwd: root, env: serverEnv, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal))
server.on('exit', (code) => process.exit(code ?? 0))

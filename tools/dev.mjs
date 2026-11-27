#!/usr/bin/env node
// Разработка клиента: vite с горячей перезагрузкой (:4173) и Rust-сервер рядом
// с игрой (tools/rust-play.mjs, порт 8788, хранилище tmp/rust-play/storage).
// Игра владельца на 8787 и рабочее storage/ не затрагиваются.
//
//   pnpm dev                    сервер с моделью из .env
//   pnpm dev -- --offline       без модели
//   pnpm dev -- --no-build      без пересборки бинаря
//
// Прежний `pnpm dev` поднимал JS-сервер (server/dev.mjs); с 2026-11-27 он в
// архиве (archive/js-server).
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const port = portIndex >= 0 && args[portIndex + 1] ? args[portIndex + 1] : '8788'
const serverArgs = portIndex >= 0 ? args : ['--port', port, ...args]

const agent = spawn(process.execPath, [join(root, 'tools', 'rust-play.mjs'), ...serverArgs], { cwd: root, stdio: 'inherit' })
// vite ходит к серверу через прокси по AGENT_PORT (vite.config.ts).
const client = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '0.0.0.0', '--port', '4173'], {
  cwd: root,
  env: { ...process.env, AGENT_PORT: port },
  stdio: 'inherit',
})

function stop(code = 0) {
  client.kill()
  agent.kill()
  process.exit(code)
}

client.on('exit', (code) => stop(code ?? 0))
agent.on('exit', (code) => stop(code ?? 0))
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())

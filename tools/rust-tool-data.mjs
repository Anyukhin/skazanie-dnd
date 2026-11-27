import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { REPO_ROOT } from '../test/kit/http.mjs'
import { serverBatch, serverCall } from '../test/kit/fixtures.mjs'

/** Для обычного запуска собираем подкоманду из текущего дерева. */
function prepareBinary() {
  if (process.env.SKAZANIE_RUST_SERVER_BIN) return
  const rust = join(REPO_ROOT, 'rust')
  const target = resolve(rust, process.env.CARGO_TARGET_DIR || 'target')
  const binary = join(target, 'release', process.platform === 'win32' ? 'skazanie-server.exe' : 'skazanie-server')
  const extraPath = [join(homedir(), '.cargo', 'bin'), join(homedir(), '.cargo', 'mingw64-root', 'mingw64', 'bin')].filter(existsSync)
  const env = { ...process.env, PATH: [...extraPath, process.env.PATH].join(delimiter), CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '4' }
  const result = spawnSync('cargo', ['build', '--release', '--locked', '-p', 'sk-server', '--features', 'test-hooks', '--bin', 'skazanie-server'],
    { cwd: rust, env, stdio: ['ignore', 'ignore', 'inherit'] })
  if (result.error) throw result.error
  if (result.status !== 0 || !existsSync(binary)) throw new Error('Не удалось собрать Rust-подкоманду fixture')
  process.env.SKAZANIE_RUST_SERVER_BIN = binary
}

export function rustToolCall(name, ...args) {
  prepareBinary()
  return serverCall(name, ...args)
}

export function rustToolBatch(calls) {
  prepareBinary()
  return serverBatch(calls)
}

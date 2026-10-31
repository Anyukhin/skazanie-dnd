// Прогон контрактных HTTP-тестов из `test/contract-rust.list` против выбранной
// реализации сервера: `node test/kit/run-contract.mjs --impl rust|js`.
//
// Скрипты: `pnpm test:contract:rust` (бинарь из SKAZANIE_RUST_SERVER_BIN) и
// `pnpm test:contract:js` (тот же список против эталонного JS-сервера).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { REPO_ROOT, SERVER_IMPLS, rustServerBinary } from './http.mjs'

/**
 * Файлы списка: без комментариев и пустых строк, только `test/*.test.mjs`.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function contractFiles(source) {
  const files = source.split(/\r?\n/u)
    .map((line) => line.replace(/#.*$/u, '').trim())
    .filter(Boolean)
  for (const file of files) {
    if (!/^test\/[^/]+\.test\.mjs$/u.test(file)) throw new Error(`contract-rust.list: ${file} — ожидается test/<имя>.test.mjs`)
  }
  const duplicate = files.find((file, index) => files.indexOf(file) !== index)
  if (duplicate) throw new Error(`contract-rust.list: ${duplicate} указан дважды`)
  return files
}

function main() {
  const flag = process.argv.indexOf('--impl')
  const impl = flag >= 0 ? process.argv[flag + 1] : 'rust'
  if (!SERVER_IMPLS.includes(String(impl))) throw new Error(`--impl: допустимы ${SERVER_IMPLS.join(', ')}`)
  const files = contractFiles(readFileSync(join(REPO_ROOT, 'test', 'contract-rust.list'), 'utf8'))
  const missing = files.filter((file) => !existsSync(join(REPO_ROOT, file)))
  if (missing.length) throw new Error(`contract-rust.list: нет файлов ${missing.join(', ')}`)
  if (!files.length) {
    console.log('test/contract-rust.list пуст — контрактных тестов пока нет')
    return
  }
  // Режим rust без бинаря — явный отказ до запуска, а не десятки одинаковых падений.
  if (impl === 'rust') rustServerBinary()
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...files], {
    cwd: REPO_ROOT,
    env: { ...process.env, SKAZANIE_SERVER_IMPL: impl },
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

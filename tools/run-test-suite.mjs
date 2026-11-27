import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { contractFiles } from '../test/kit/run-contract.mjs'

// `pnpm test`: тесты клиента, инструментов и общей JS-библиотеки — без сервера.
// Контрактные HTTP-тесты из test/contract-rust.list идут против бинаря Rust
// отдельной командой `pnpm test:contract` (нужен SKAZANIE_RUST_SERVER_BIN):
// JS-сервера, против которого корпус гонялся раньше, с 2026-11-27 нет
// (archive/js-server).

// Тесты включают модель только через собственную заглушку.
process.env.DND_AI_OLLAMA_MODEL = ''
process.env.OPENROUTER_API_KEY = ''

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const testDir = join(rootDir, 'test')
const performanceFile = 'tactical-map-budget.test.mjs'
const contract = new Set(contractFiles(readFileSync(join(testDir, 'contract-rust.list'), 'utf8')))
const functionalFiles = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs') && name !== performanceFile)
  .map((name) => relative(rootDir, join(testDir, name)).replaceAll('\\', '/'))
  .filter((file) => !contract.has(file))
  .sort()

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.signal) {
    console.error(`Тестовый процесс завершён сигналом ${result.signal}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// Временные бюджеты нельзя измерять рядом с остальным корпусом: shared CPU
// превращает проверку регрессии в проверку загруженности машины. Бюджет
// меряется первым, на холодной машине; пороги и число прогонов прежние.
runNode(['--test', join('test', performanceFile)])
runNode(['--test', '--test-concurrency=4', ...functionalFiles])

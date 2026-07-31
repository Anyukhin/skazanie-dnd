import { readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const testDir = join(rootDir, 'test')
const performanceFile = 'tactical-map-budget.test.mjs'
const functionalFiles = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs') && name !== performanceFile)
  .sort()
  .map((name) => relative(rootDir, join(testDir, name)))

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

// Временные бюджеты нельзя измерять рядом с HTTP/e2e-процессами: shared CPU
// превращает проверку регрессии в проверку загруженности runner. Функциональный
// корпус остаётся параллельным, а неизменённые performance-пороги получают
// отдельный процесс после него.
runNode(['--test', '--test-concurrency=4', ...functionalFiles])
runNode(['--test', join('test', performanceFile)])

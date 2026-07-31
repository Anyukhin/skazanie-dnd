import { readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const testDir = join(rootDir, 'test')
const longRunningFile = 'mvp-player-cycle-api.test.mjs'
const performanceFile = 'tactical-map-budget.test.mjs'
const isolatedFiles = new Set([longRunningFile, performanceFile])
const functionalFiles = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs') && !isolatedFiles.has(name))
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

// Полный MVP-сценарий сам поднимает HTTP-сервер, проигрывает случайный бой и
// перезапускает процесс несколько раз. Рядом ещё с тремя файлами он упирается
// в собственный timeout 600 с; одиночный замер 2026-07-31 занял 338 с.
//
// Временные бюджеты тоже нельзя измерять рядом с HTTP/e2e-процессами: shared
// CPU превращает проверку регрессии в проверку загруженности runner.
// Функциональный корпус остаётся параллельным, а оба чувствительных файла
// получают собственные процессы; лимиты и performance-пороги не меняются.
runNode(['--test', '--test-concurrency=4', ...functionalFiles])
runNode(['--test', join('test', longRunningFile)])
runNode(['--test', join('test', performanceFile)])

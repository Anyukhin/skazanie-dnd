import { readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { cpus } from 'node:os'
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
// Измеряем бюджеты на холодном runner до всего корпуса: даже функциональная часть
// загружает shared CPU несколько минут, а долгий MVP-сценарий ещё несколько раз
// поднимает HTTP-процессы. Пороги и число прогонов остаются прежними.
runNode(['--test', join('test', performanceFile)])

// Дальше порядок зависит от машины. Изоляция MVP-сценария была защитой от
// 2-ядерного раннера CI, где рядом он упирался в собственный тайм-аут. На
// машине разработчика с запасом ядер это чистая потеря: сценарий занимает
// ~220 с и просто ждёт, пока функциональный корпус (~95 с) освободит очередь.
// Замер 2026-08-01 на 16 ядрах: последовательный прогон ~5,5 мин,
// параллельный — 257 с (~4,3 мин), весь корпус зелёный: 1676/1676 + MVP 1/1. Пороги, лимиты и состав корпуса не меняются.
const sharedRunner = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'

/**
 * Один повтор MVP-сценария — только на общем раннере. Сценарий играет
 * настоящий бой без сида, и партия имеет право проиграть: за 2026-07-31 этот
 * файл дал пять ложных красных на разных ветках (проигрыши, тайм-ауты,
 * `fetch failed` на загруженном раннере). Один повтор превращает редкую
 * неудачу в шум, но два подряд — по-прежнему падение: настоящий регресс боя
 * не проскочит. Локально повторов нет — там прогон тихий и быстрый, и
 * стохастику полезно видеть.
 */
function runLongScenario() {
  const args = ['--test', join('test', longRunningFile)]
  if (!sharedRunner) { runNode(args); return }
  const first = spawnSync(process.execPath, args, { cwd: rootDir, env: process.env, stdio: 'inherit' })
  if (first.status === 0) return
  console.error('MVP-сценарий упал на общем раннере — один повтор (см. комментарий выше)')
  runNode(args)
}

const enoughCores = (cpus()?.length ?? 0) >= 8
if (sharedRunner || !enoughCores) {
  runNode(['--test', '--test-concurrency=4', ...functionalFiles])
  runLongScenario()
} else {
  // MVP стартует первым и работает, пока идёт функциональный корпус; его
  // вывод буферизуется и печатается после — иначе TAP двух процессов
  // перемешается и сводку станет невозможно читать.
  const mvp = spawn(process.execPath, ['--test', join('test', longRunningFile)], {
    cwd: rootDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let mvpOutput = ''
  mvp.stdout.on('data', (chunk) => { mvpOutput += chunk })
  mvp.stderr.on('data', (chunk) => { mvpOutput += chunk })
  const mvpDone = new Promise((resolve) => mvp.once('close', resolve))

  runNode(['--test', '--test-concurrency=4', ...functionalFiles])

  const mvpStatus = await mvpDone
  process.stdout.write(mvpOutput)
  if (mvpStatus !== 0) process.exit(mvpStatus ?? 1)
}

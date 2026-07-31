import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const runner = readFileSync(new URL('../tools/run-test-suite.mjs', import.meta.url), 'utf8')

test('долгий MVP и performance-бюджеты исключены из параллельного корпуса', () => {
  // Инвариант прежний: оба чувствительных файла не попадают в общий пул с
  // --test-concurrency и получают собственные процессы. Изменилась только
  // форма: на машине с запасом ядер MVP работает параллельно корпусу, и это
  // проверяется ниже отдельно.
  assert.match(runner, /const isolatedFiles = new Set\(\[longRunningFile, performanceFile\]\)/u)
  assert.match(runner, /!isolatedFiles\.has\(name\)/u)
  assert.match(runner, /runNode\(\['--test', '--test-concurrency=4', \.\.\.functionalFiles\]\)/u)
  assert.match(runner, /runNode\(\['--test', join\('test', performanceFile\)\]\)/u)
})

test('performance-бюджеты измеряются первыми, на холодной машине', () => {
  assert.ok(
    runner.indexOf("join('test', performanceFile)") < runner.indexOf("'--test-concurrency=4'"),
    'бюджеты должны идти до функционального корпуса',
  )
})

test('на общем раннере порядок последовательный, MVP — с одним повтором', () => {
  // 2-ядерный раннер CI — причина, по которой изоляция вообще заведена:
  // рядом с корпусом MVP упирался в собственный тайм-аут.
  assert.match(runner, /if \(sharedRunner \|\| !enoughCores\) \{/u)
  assert.match(runner, /runLongScenario\(\)/u)
  assert.match(runner, /if \(!sharedRunner\) \{ runNode\(args\); return \}/u)
  // Повтор ровно один: два падения подряд валят прогон, регресс боя не проскочит.
  assert.match(runner, /if \(first\.status === 0\) return/u)
})

test('на машине с запасом ядер MVP идёт параллельно корпусу с буферизацией вывода', () => {
  assert.match(runner, /const mvp = spawn\(process\.execPath, \['--test', join\('test', longRunningFile\)\]/u)
  assert.match(runner, /mvpOutput \+= chunk/u)
  assert.match(runner, /process\.stdout\.write\(mvpOutput\)/u,
    'вывод MVP обязан буферизоваться, иначе TAP двух прогонов перемешается')
  assert.match(runner, /if \(mvpStatus !== 0\) process\.exit\(mvpStatus \?\? 1\)/u,
    'падение MVP обязано валить прогон и в параллельном режиме')
})

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const runner = readFileSync(new URL('../tools/run-test-suite.mjs', import.meta.url), 'utf8')

function fixtureSource({ failing }) {
  const functional = failing
    ? "import test from 'node:test'\ntest('functional fixture fails', async () => { await new Promise((resolve) => setTimeout(resolve, 700)); throw new Error('FUNCTIONAL_FIXTURE_FAILURE') })\n"
    : "import test from 'node:test'\ntest('functional fixture passes', () => { console.log('FUNCTIONAL_FIXTURE') })\n"
  return {
    performance: "import test from 'node:test'\ntest('performance fixture', () => { console.log('PERFORMANCE_FIXTURE') })\n",
    functional,
    mvp: "import { appendFileSync, writeSync } from 'node:fs'\nimport test from 'node:test'\ntest('MVP fixture', async () => { appendFileSync(process.env.OPTIMIZATION_RUNNER_MARKER, 'MVP_STARTED\\n'); process.stdout.write('MVP_FIXTURE_STARTED\\n'); writeSync(1, Buffer.alloc(256 * 1024, 120)); appendFileSync(process.env.OPTIMIZATION_RUNNER_MARKER, 'MVP_STREAM_COMPLETE\\n'); await new Promise((resolve) => setTimeout(resolve, 1500)); appendFileSync(process.env.OPTIMIZATION_RUNNER_MARKER, 'MVP_COMPLETED\\n'); process.stdout.write('MVP_FIXTURE_COMPLETED\\n') })\n",
  }
}

function runFixture({ failing, mvpFailing = false }) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-test-suite-'))
  const testDir = join(root, 'test')
  const toolsDir = join(root, 'tools')
  const marker = join(root, 'mvp.marker')
  mkdirSync(testDir)
  mkdirSync(toolsDir)
  const source = fixtureSource({ failing })
  writeFileSync(join(testDir, 'tactical-map-budget.test.mjs'), source.performance)
  writeFileSync(join(testDir, 'functional-fixture.test.mjs'), source.functional)
  writeFileSync(join(testDir, 'mvp-player-cycle-api.test.mjs'), mvpFailing
    ? "import test from 'node:test'\ntest('MVP fixture fails', () => { throw new Error('MVP_FIXTURE_FAILURE') })\n"
    : source.mvp)
  const fixtureRunner = join(toolsDir, 'run-test-suite.mjs')
  writeFileSync(fixtureRunner, runner.replace('const enoughCores = (cpus()?.length ?? 0) >= 8', 'const enoughCores = true'))
  const env = { ...process.env, OPTIMIZATION_RUNNER_MARKER: marker }
  delete env.CI
  delete env.GITHUB_ACTIONS
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [fixtureRunner], { cwd: root, env, encoding: 'utf8', timeout: 10_000 })
  return { root, marker, result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

test('долгий MVP и performance-бюджеты исключены из параллельного корпуса', () => {
  // Инвариант прежний: оба чувствительных файла не попадают в общий пул с
  // --test-concurrency и получают собственные процессы. Изменилась только
  // форма: на машине с запасом ядер MVP работает параллельно корпусу, и это
  // проверяется ниже отдельно.
  assert.match(runner, /const isolatedFiles = new Set\(\[longRunningFile, performanceFile\]\)/u)
  assert.match(runner, /!isolatedFiles\.has\(name\)/u)
  assert.match(runner, /runNodeAsync\(\['--test', '--test-concurrency=4', \.\.\.functionalFiles\]\)/u)
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

test('ошибка функционального корпуса дожидается MVP и сохраняет его буферизованный вывод', () => {
  const fixture = runFixture({ failing: true })
  try {
    assert.notEqual(fixture.result.error?.code, 'ETIMEDOUT', 'runner завис вместо завершения дочерних процессов')
    assert.notEqual(fixture.result.status, 0, 'ошибка функционального корпуса потерялась')
    assert.match(fixture.output, /FUNCTIONAL_FIXTURE_FAILURE/u)
    assert.match(fixture.output, /MVP_FIXTURE_STARTED/u, 'буфер MVP не был выведен перед ошибкой')
    assert.match(fixture.output, /MVP_FIXTURE_COMPLETED/u, 'runner не дождался и не вывел буфер MVP')
    assert.match(readFileSync(fixture.marker, 'utf8'), /MVP_STARTED/u)
    assert.match(readFileSync(fixture.marker, 'utf8'), /MVP_STREAM_COMPLETE/u, 'spawnSync заблокировал чтение MVP pipe')
    assert.match(readFileSync(fixture.marker, 'utf8'), /MVP_COMPLETED/u, 'MVP завершился после выхода runner')
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('успешный запуск сохраняет порядок performance → functional → MVP', () => {
  const fixture = runFixture({ failing: false })
  try {
    assert.equal(fixture.result.status, 0, fixture.output)
    const performanceIndex = fixture.output.indexOf('PERFORMANCE_FIXTURE')
    const functionalIndex = fixture.output.indexOf('FUNCTIONAL_FIXTURE')
    const mvpIndex = fixture.output.indexOf('MVP_FIXTURE_STARTED')
    assert.ok(performanceIndex >= 0 && functionalIndex > performanceIndex && mvpIndex > functionalIndex, fixture.output)
    assert.match(readFileSync(fixture.marker, 'utf8'), /MVP_COMPLETED/u)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('ошибка MVP завершает общий запуск с ошибкой даже при зелёном функциональном корпусе', () => {
  const fixture = runFixture({ failing: false, mvpFailing: true })
  try {
    assert.equal(fixture.result.error, undefined)
    assert.notEqual(fixture.result.status, 0)
    assert.match(fixture.output, /FUNCTIONAL_FIXTURE/u)
    assert.match(fixture.output, /MVP_FIXTURE_FAILURE/u)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

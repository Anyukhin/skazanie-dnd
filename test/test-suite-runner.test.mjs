import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// `pnpm test` (tools/run-test-suite.mjs): бюджет tactical-map — первым и в
// своём процессе, затем модульный корпус без контрактных HTTP-тестов. Контракт
// идёт против бинаря Rust отдельной командой `pnpm test:contract`.
const runner = readFileSync(new URL('../tools/run-test-suite.mjs', import.meta.url), 'utf8')

const PASS = (marker) => `import test from 'node:test'\ntest('${marker}', () => { console.log('${marker}') })\n`
const FAIL = (marker) => `import test from 'node:test'\ntest('${marker}', () => { throw new Error('${marker}') })\n`

function runFixture({ functionalFailing = false, performanceFailing = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-test-suite-'))
  mkdirSync(join(root, 'test', 'kit'), { recursive: true })
  mkdirSync(join(root, 'tools'))
  writeFileSync(join(root, 'test', 'tactical-map-budget.test.mjs'), (performanceFailing ? FAIL : PASS)('PERFORMANCE_FIXTURE'))
  writeFileSync(join(root, 'test', 'functional-fixture.test.mjs'), (functionalFailing ? FAIL : PASS)('FUNCTIONAL_FIXTURE'))
  // Контрактный файл без бинаря упал бы — общий корпус его не запускает.
  writeFileSync(join(root, 'test', 'contract-fixture.test.mjs'), FAIL('CONTRACT_FIXTURE_RAN'))
  writeFileSync(join(root, 'test', 'contract-rust.list'), '# контракт\ntest/contract-fixture.test.mjs   # против Rust\n')
  writeFileSync(join(root, 'test', 'kit', 'run-contract.mjs'),
    "export function contractFiles(source) { return source.split(/\\r?\\n/u).map((line) => line.replace(/#.*$/u, '').trim()).filter(Boolean) }\n")
  writeFileSync(join(root, 'tools', 'run-test-suite.mjs'), runner)
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [join(root, 'tools', 'run-test-suite.mjs')], { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
  return { root, result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

test('бюджет tactical-map идёт первым и в своём процессе', () => {
  assert.match(runner, /name !== performanceFile/u, 'бюджет не должен попадать в общий пул с --test-concurrency')
  assert.ok(
    runner.indexOf("runNode(['--test', join('test', performanceFile)])") < runner.indexOf("'--test-concurrency=4'"),
    'бюджет должен меряться до функционального корпуса, на холодной машине',
  )
})

test('контрактные тесты из test/contract-rust.list в общий корпус не входят', () => {
  assert.match(runner, /contractFiles\(readFileSync\(join\(testDir, 'contract-rust\.list'\), 'utf8'\)\)/u)
  assert.match(runner, /\.filter\(\(file\) => !contract\.has\(file\)\)/u)
})

test('успешный запуск: бюджет, затем корпус, контракт не запускается', () => {
  const fixture = runFixture()
  try {
    assert.equal(fixture.result.status, 0, fixture.output)
    const performance = fixture.output.indexOf('PERFORMANCE_FIXTURE')
    const functional = fixture.output.indexOf('FUNCTIONAL_FIXTURE')
    assert.ok(performance >= 0 && functional > performance, fixture.output)
    assert.doesNotMatch(fixture.output, /CONTRACT_FIXTURE_RAN/u)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('падение корпуса завершает запуск с ошибкой', () => {
  const fixture = runFixture({ functionalFailing: true })
  try {
    assert.equal(fixture.result.error, undefined)
    assert.notEqual(fixture.result.status, 0)
    assert.match(fixture.output, /FUNCTIONAL_FIXTURE/u)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('падение бюджета останавливает запуск до корпуса', () => {
  const fixture = runFixture({ performanceFailing: true })
  try {
    assert.notEqual(fixture.result.status, 0)
    assert.doesNotMatch(fixture.output, /✔ FUNCTIONAL_FIXTURE|ok \d+ - FUNCTIONAL_FIXTURE/u)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

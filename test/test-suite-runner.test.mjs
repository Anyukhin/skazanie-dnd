import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const runner = readFileSync(new URL('../tools/run-test-suite.mjs', import.meta.url), 'utf8')

test('долгий MVP и performance-бюджеты исключены из параллельного корпуса и запускаются отдельно', () => {
  assert.match(runner, /const isolatedFiles = new Set\(\[longRunningFile, performanceFile\]\)/u)
  assert.match(runner, /!isolatedFiles\.has\(name\)/u)
  assert.match(runner, /runNode\(\['--test', '--test-concurrency=4', \.\.\.functionalFiles\]\)/u)
  assert.match(runner, /runNode\(\['--test', join\('test', longRunningFile\)\]\)/u)
  assert.match(runner, /runNode\(\['--test', join\('test', performanceFile\)\]\)/u)
})

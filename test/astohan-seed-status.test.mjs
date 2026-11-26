import assert from 'node:assert/strict'
import test from 'node:test'

import { endingFor, seedPassed, victoryFor } from '../eval/astohan-seed-status.mjs'

test('поражение завершает кампанию, но не считается победой', () => {
  const report = {
    scorecard: { status: 'completed', ending: 'defeat', victory: false, blockers: 0, critical: 0 },
    final: { lifecycle: { status: 'completed', ending: { id: 'defeat' } } },
    audit: { status: 0 },
  }
  assert.equal(endingFor(report), 'defeat')
  assert.equal(victoryFor(endingFor(report)), false)
  assert.equal(seedPassed(report), true, 'чистый сюжетный проигрыш не является сбоем стенда')
})

test('сбой replay не проходит серию с чистым счётом блокеров', () => {
  const report = {
    scorecard: { status: 'completed', ending: 'treaty', victory: true, blockers: 0, critical: 0 },
    audit: { status: 1 },
  }
  assert.equal(seedPassed(report), false)
})

test('неподтверждённый audit ready не считается зелёным', () => {
  const report = {
    scorecard: { blockers: 0, critical: 0 },
    audit: { status: 0, ready: false },
  }
  assert.equal(seedPassed(report), false)
})

test('неизвестный или отсутствующий исход не считается победой', () => {
  assert.equal(victoryFor('unexpected'), null)
  assert.equal(victoryFor(null), null)
  assert.equal(victoryFor('treaty'), true)
})

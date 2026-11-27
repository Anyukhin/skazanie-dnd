import assert from 'node:assert/strict'
import test from 'node:test'

import { compareNarratorCraftReports, measureNarratorCraft } from '../eval/narrator-craft-metrics.mjs'

const before = { samples: [{ id: '1', kind: 'narrator', text: 'Воздух густеет.' }] }
const after = { samples: [] }

test('сырые выборки сравниваются по общему словарю клише', () => {
  const comparison = compareNarratorCraftReports(before, after)
  assert.equal(comparison.before.cliches.occurrences, 1)
  assert.equal(comparison.after.cliches.occurrences, 0)
  assert.equal(comparison.delta.cliche_occurrences, -1)
  assert.equal(comparison.trend.cliches_improved, true)
})

test('прямой вызов учитывает клише и сохраняет словарь при пустой выборке', () => {
  const measured = measureNarratorCraft(before.samples)
  assert.equal(measured.cliches.catalog.find((entry) => entry.id === 'air-thickens')?.count, 1)

  const empty = measureNarratorCraft()
  assert.deepEqual(empty, measureNarratorCraft([]))
  assert.equal(empty.cliches.occurrences, 0)
  assert.equal(empty.cliches.catalog.find((entry) => entry.id === 'air-thickens')?.count, 0)
})

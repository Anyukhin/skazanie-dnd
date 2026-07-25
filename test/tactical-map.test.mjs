import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/tactical-engine.ts', import.meta.url), 'utf8')

test('tactical browser module exposes presentation helpers only', () => {
  const exports = [...source.matchAll(/export\s+(?:const|function)\s+([A-Za-z0-9_]+)/gu)].map((match) => match[1]).sort()
  assert.deepEqual(exports, ['CELL_FEET', 'currentTacticalTurn', 'mapGridDimensions'])
})

test('tactical browser module contains no gameplay RNG or mutation exports', () => {
  assert.doesNotMatch(source, /Math\.random|attackEnemyOnMap|finishTacticalTurn|movePlayerOnMap|damage|hp\s*[-+]=/u)
})

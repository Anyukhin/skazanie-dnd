import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('browser sends no full room mutation and contains no gameplay RNG fallback', () => {
  const session = source('../src/useGameSession.ts')
  const game = source('../src/game-engine.ts')
  const tactical = source('../src/tactical-engine.ts')
  const client = source('../src/ai-client.ts')
  assert.doesNotMatch(session, /method:\s*['"]PUT['"]|Math\.random|createLocalCheck|resolveAction/u)
  assert.doesNotMatch(`${game}\n${tactical}`, /Math\.random|attackEnemyOnMap|finishTacticalTurn|movePlayerOnMap/u)
  assert.doesNotMatch(client, /JSON\.stringify\(\{\s*state|Math\.random/u)
})

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('orchestrator has no executable legacy or shadow branch', () => {
  const orchestrator = source('../server/game-orchestrator.mjs')
  assert.doesNotMatch(orchestrator, /legacyHandler|mode\s*===\s*['"]legacy['"]|mode\s*===\s*['"]shadow['"]|LegacyStateSynchronized|compareShadowResults/u)
  assert.match(orchestrator, /const mode = ['"]enforce['"]/u)
})

test('browser sends no full room mutation and contains no gameplay RNG fallback', () => {
  const session = source('../src/useGameSession.ts')
  const game = source('../src/game-engine.ts')
  const tactical = source('../src/tactical-engine.ts')
  const client = source('../src/ai-client.ts')
  assert.doesNotMatch(session, /method:\s*['"]PUT['"]|Math\.random|createLocalCheck|resolveAction/u)
  assert.doesNotMatch(`${game}\n${tactical}`, /Math\.random|attackEnemyOnMap|finishTacticalTurn|movePlayerOnMap/u)
  assert.doesNotMatch(client, /JSON\.stringify\(\{\s*state|Math\.random/u)
})

test('server retires mode switching and broad room writes', () => {
  const index = source('../server/index.mjs')
  assert.match(index, /ENGINE_MODE_RETIRED/u)
  assert.match(index, /ROOM_MUTATION_RETIRED/u)
  assert.match(index, /LEGACY_PAYLOAD_RETIRED/u)
  assert.doesNotMatch(index, /legacyHandler:\s*legacyTurnHandler/u)
  assert.equal(existsSync(new URL('../prompts/legacy/v1.txt', import.meta.url)), false)
})

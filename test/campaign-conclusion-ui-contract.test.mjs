import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('поражение показывает судьбу отряда перед эпилогом и не накладывает два финальных экрана', () => {
  assert.match(app, />К эпилогу</u)
  assert.match(app, /const partyDefeatReviewed = reviewedPartyDefeat === state\.sessionCode/u)
  assert.match(app, /const showDeathScreen = fallenHeroes\.length > 0 && \(!partyDefeated \|\| !partyDefeatReviewed\)/u)
  assert.match(app, /const showConclusion = \['completed', 'failed', 'archived'\]\.includes\(lifecycleStatus\)/u)
  assert.match(app, /partyDefeated && partyDefeatReviewed/u)
  assert.match(app, /История завершилась поражением/u)
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { CAPTIVE_PLAYER_COMMAND_TYPES } from '../server/captives.mjs'

const board = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('клиент называет только пленного и подход: СЛ и исход остаются серверными', () => {
  for (const type of CAPTIVE_PLAYER_COMMAND_TYPES) {
    assert.ok(session.includes(`command_type: '${type}'`), `клиент не умеет отправлять ${type}`)
  }
  assert.match(session, /captiveAction = useCallback/u)
  assert.match(app, /onCaptiveAction=\{\(captiveId, action, skill\) => captiveAction\(activePlayer\.id, captiveId, action, skill\)\}/u)
  // Ни сложности, ни награды, ни исхода броска в клиентской команде быть не должно.
  assert.doesNotMatch(session, /captive_id[^\n]*difficulty/u)
  assert.doesNotMatch(session, /bounty_cp/u)
  assert.doesNotMatch(board, /bounty_cp/u)
})

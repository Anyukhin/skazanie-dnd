import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { CAPTIVE_PLAYER_COMMAND_TYPES } from '../server/captives.mjs'

const board = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('пленник виден на панели сцены с меткой и полным набором кнопок', () => {
  assert.match(board, /className="captive-panel"/u)
  assert.match(board, /ПЛЕННИКИ · \{heldCaptives\.length\}/u)
  assert.match(board, /className="captive-tag">ПЛЕННИК</u)
  for (const label of ['Допросить', 'Уговорить', 'Накормить', 'Отпустить', 'Сдать страже', 'Убить']) {
    assert.ok(board.includes(`>${label}</button>`), `в меню пленного нет кнопки «${label}»`)
  }
  // Голод обязан быть видим: иначе жестокость наступает молча.
  assert.match(board, /captive\.neglected_at_minutes != null/u)
  assert.match(board, /Голодает — это уже жестокость/u)
})

test('меню самого NPC тоже помечает пленника и даёт те же действия', () => {
  assert.match(board, /className="npc-dialog-captive"><small>ПОЛОЖЕНИЕ<\/small><b>Пленник отряда<\/b>/u)
  assert.match(board, /className="npc-dialog-captive-actions"/u)
  assert.match(board, /dossierCaptive = dossierSceneNpc \? captiveByNpcId\.get\(dossierSceneNpc\.id\)/u)
})

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

test('панель пленных оформлена и отличает голодающего', () => {
  assert.match(styles, /\.captive-panel \{/u)
  assert.match(styles, /\.captive-card\.starving \{/u)
  assert.match(styles, /\.captive-tag \{/u)
  assert.match(styles, /\.captive-actions button\.captive-execute \{/u)
})

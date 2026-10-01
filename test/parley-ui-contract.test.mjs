import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { tacticalCommandRequest } from '../src/tactical-command-recovery.mjs'

import { PARLEY_OUTCOMES, PARLEY_TERMS } from '../server/parley.mjs'

/**
 * Сквозное требование владельца: у каждой механики есть UI-критерий. Перемирие
 * — самый наглядный случай, потому что оно **останавливает бой**: если стол не
 * видит, почему очередь стоит, механика читается как зависший интерфейс.
 *
 * Сторож держит ровно три обещания: перемирие видно на самой доске, условия
 * показаны карточкой с подписями всех серверных исходов, а клиент не считает
 * ни СЛ, ни доступность исхода сам.
 */
const board = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const shared = readFileSync(new URL('../src/app-shared.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('карточка условий показывает все серверные исходы и ничего сверх них', () => {
  assert.match(board, /className="truce-panel"/u)
  assert.match(board, /PARLEY_TERM_LABELS/u)
  for (const outcome of PARLEY_OUTCOMES) {
    assert.match(board, new RegExp(`\\b${outcome}: \\{ label:`, 'u'), `в карточке условий нет исхода ${outcome}`)
  }
  // Клиент рисует только те исходы, которые объявил сервер.
  assert.match(board, /\(truce\.outcomes \?\? \[\]\)\.map/u)
  assert.equal(Object.keys(PARLEY_TERMS).length, PARLEY_OUTCOMES.length)
  assert.match(styles, /\.truce-panel \{/u)
  assert.match(styles, /\.truce-term \{/u)
})

test('клиент называет только подход и исход: СЛ, мораль и откуп остаются серверными', () => {
  assert.match(session, /command_type: 'ProposeParley'/u)
  assert.match(session, /command_type: 'SettleParley'/u)
  assert.match(app, /onProposeParley=\{\(skill\) => proposeParley\(activePlayer\.id, skill\)\}/u)
  assert.match(app, /onSettleParley=\{\(outcome\) => settleParley\(activePlayer\.id, outcome\)\}/u)
  // Ни СЛ, ни давление морали, ни сумма откупа в клиентской команде не считаются.
  assert.doesNotMatch(session, /parley[^\n]*difficulty/iu)
  assert.doesNotMatch(session, /tribute_cp/u)
})

test('ручной бросок парлея двухфазный: карточка проверки, затем та же команда с roll_id', () => {
  assert.match(session, /manualRoll: dice\.manualRoll === true/u)
  assert.match(session, /rollId: dice\.roll\.roll_id/u)
  const pending = {
    campaignId: 'PARLEY', requestId: 'parley-original', message: 'Предложить переговоры',
    command: { command_type: 'ProposeParley', actor_id: 'hero', skill: 'persuasion' },
  }
  const first = tacticalCommandRequest({ ...pending, manualRoll: true }).body
  assert.equal(first.manual_roll, true)
  assert.equal(first.roll, undefined)
  const second = tacticalCommandRequest({ ...pending, rollId: 'server-roll' }).body
  assert.deepEqual(second.command, first.command)
  assert.deepEqual(second.roll, { roll_id: 'server-roll' })
  assert.equal(second.manual_roll, undefined)
  assert.match(session, /check\.command/u)
  // Развилка карточки закреплена **списком** двухфазных команд, а не одним
  // парлеем. Раньше здесь стояло дословное
  // `result?.check && command.command_type === 'ProposeParley'`, и проверка
  // держала не контракт, а ошибку: с тем же условием карточки побега от стражи
  // и ответного броска за костями приходили с сервера и молча пропадали.
  // Полный сторож списка — `test/tavern-ui-contract.test.mjs`, здесь довольно
  // того, что парлей из него не выпал.
  assert.match(session, /result\?\.check && twoPhase/u)
  assert.match(session, /function twoPhaseCheckCommandFor[\s\S]*?case 'ProposeParley':/u)
})

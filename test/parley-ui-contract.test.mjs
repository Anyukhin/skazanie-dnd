import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

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

test('перемирие заметно на доске: рамка, полоса и раунд', () => {
  assert.match(board, /truce-held/u, 'у доски нет состояния перемирия')
  assert.match(board, /className="truce-banner"/u)
  assert.match(board, /ПЕРЕМИРИЕ · РАУНД/u)
  assert.match(styles, /\.map-stage\.truce-held::after \{/u, 'рамка перемирия обязана рисоваться на самой доске')
  assert.match(styles, /\.truce-banner \{/u)
})

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

test('кнопка переговоров живёт в хотбаре и честно предупреждает о помехе', () => {
  assert.match(board, /className="parley-hotbar"/u)
  assert.ok(board.includes('>Переговоры</span>') || board.includes("parleyAttempted ? 'Переговоры (помеха)' : 'Переговоры'"))
  assert.match(board, /parleyAttempted/u)
  assert.match(styles, /\.parley-hotbar\.parley-hotbar \{/u)
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
  assert.match(session, /manual_roll: true/u)
  assert.match(session, /roll: \{ roll_id: dice\.roll\.roll_id \}/u)
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

test('переговоры читаются в боевой хронике, а не остаются кодом события', () => {
  for (const marker of ['parley', 'parley-rejected', 'truce', 'truce-broken', 'parley-settled']) {
    assert.ok(shared.includes(`event.type === '${marker}'`), `хроника не умеет читать запись «${marker}»`)
  }
  assert.match(shared, /под перемирием/u)
})

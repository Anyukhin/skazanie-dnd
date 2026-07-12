import assert from 'node:assert/strict'
import test from 'node:test'

import { decideTurnConsumption } from '../server/turn-policy.mjs'

const quiet = { effects: { roll: null, reveal: [], spawn: [], objective: null, grantItems: [], scene: null } }

test('реплики, вопросы, планирование и инвентарь не передают ход', () => {
  for (const action of ['Спрашиваю стражника, кто здесь был?', 'Предлагаю группе план', 'Смотрю инвентарь']) {
    assert.equal(decideTurnConsumption({ action, result: { ...quiet, turn_consumed: false } }), false, action)
  }
})

test('проверка не расходует ход до броска, но расходует после результата вне боя', () => {
  assert.equal(decideTurnConsumption({ action: 'Взламываю замок', result: { ...quiet, check: { label: 'Взлом' } } }), false)
  assert.equal(decideTurnConsumption({ action: 'Взламываю замок', result: quiet, rollResolved: true }), true)
})

test('изменение мира и переход сцены расходуют ход вне боя', () => {
  assert.equal(decideTurnConsumption({ action: 'Открываю тайную дверь', result: { effects: { ...quiet.effects, reveal: [{ x: 1, y: 1 }] } } }), true)
  assert.equal(decideTurnConsumption({ action: 'Идём дальше', result: { effects: { ...quiet.effects, scene: { scene: {} } } } }), true)
})

test('в бою действие не завершает ход без явной передачи инициативы', () => {
  const state = { mechanics: { combat: { active: true } } }
  assert.equal(decideTurnConsumption({ state, action: 'Атакую гоблина', result: { ...quiet, turn_consumed: true }, rollResolved: true }), false)
  assert.equal(decideTurnConsumption({ state, action: 'Заканчиваю свой ход', result: quiet }), true)
})

test('модель не может пометить явное окончание хода как свободное действие', () => {
  assert.equal(decideTurnConsumption({ action: 'Конец хода', result: { ...quiet, turn_consumed: false } }), true)
})

test('вопрос о лоре не расходует ход', () => {
  assert.equal(decideTurnConsumption({
    action: 'Что я знаю про легенду архивариуса?',
    result: { narration: 'Герой вспоминает известную историю.', effects: {} },
  }), false)
})

test('открытие голосования агентом не расходует ход', () => {
  assert.equal(decideTurnConsumption({
    action: 'Предлагаю покинуть подземелье',
    result: { effects: { interaction: { type: 'vote' } }, turn_consumed: true },
  }), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceExpressionError, DiceService, SequenceDiceRng, parseDiceExpression } from '../server/dice-service.mjs'

test('парсер костей нормализует выражение и отклоняет опасный ввод', () => {
  assert.deepEqual(parseDiceExpression(' 2D6 + 3 '), { count: 2, sides: 6, modifier: 3, canonical: '2d6+3' })
  assert.deepEqual(parseDiceExpression('d20-2'), { count: 1, sides: 20, modifier: -2, canonical: '1d20-2' })
  assert.throws(() => parseDiceExpression('1d20; process.exit()'), DiceExpressionError)
  assert.throws(() => parseDiceExpression('101d6'), DiceExpressionError)
  assert.throws(() => parseDiceExpression('1d1'), DiceExpressionError)
})

test('DiceService использует внедряемый RNG и возвращает трассируемый результат', () => {
  const dice = new DiceService({
    rng: new SequenceDiceRng([2, 5]),
    idFactory: () => 'roll-1',
    now: () => '2026-01-01T00:00:00.000Z',
  })
  assert.deepEqual(dice.roll('2d6+3', 'damage', 'hero-1', 'party'), {
    roll_id: 'roll-1', expression: '2d6+3', dice: [2, 5], modifier: 3, total: 10,
    purpose: 'damage', actor_id: 'hero-1', visibility: 'party', created_at: '2026-01-01T00:00:00.000Z',
  })
})

test('преимущество, помеха и их взаимное погашение обрабатываются кодом', () => {
  const advantage = new DiceService({ rng: new SequenceDiceRng([4, 17]), idFactory: () => 'a' })
  assert.deepEqual(advantage.rollD20({ modifier: 3, advantage: true }).dice, [4, 17])
  assert.equal(new DiceService({ rng: new SequenceDiceRng([4, 17]), idFactory: () => 'b' }).rollD20({ disadvantage: true }).kept, 4)
  const cancelled = new DiceService({ rng: new SequenceDiceRng([11]), idFactory: () => 'c' }).rollCheck({ modifier: 2, difficulty: 13, advantage: true, disadvantage: true })
  assert.equal(cancelled.mode, 'normal')
  assert.equal(cancelled.success, true)
  assert.equal(cancelled.total, 13)
})


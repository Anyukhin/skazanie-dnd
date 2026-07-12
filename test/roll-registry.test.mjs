import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { RollRegistry } from '../server/roll-registry.mjs'

test('серверный roll_id нельзя подменить, передать другому герою или использовать дважды', () => {
  let now = 1000
  const registry = new RollRegistry({
    diceService: new DiceService({ rng: new SequenceDiceRng([14]), idFactory: () => 'roll-1' }),
    now: () => now,
    ttlMs: 100,
  })
  const issued = registry.issue({ campaignId: 'ROOM', actorId: 'hero', label: 'Атака', modifier: 4, difficulty: 15 })
  assert.equal(issued.total, 18)
  assert.equal(issued.success, true)
  assert.throws(() => registry.consume('roll-1', { campaignId: 'ROOM', actorId: 'other', idempotencyKey: 'turn-1' }), (error) => error.code === 'ROLL_FORBIDDEN')
  assert.equal(registry.consume('roll-1', { campaignId: 'ROOM', actorId: 'hero', idempotencyKey: 'turn-1' }).total, 18)
  assert.equal(registry.consume('roll-1', { campaignId: 'ROOM', actorId: 'hero', idempotencyKey: 'turn-1' }).total, 18)
  assert.throws(() => registry.consume('roll-1', { campaignId: 'ROOM', actorId: 'hero', idempotencyKey: 'turn-2' }), (error) => error.code === 'ROLL_ALREADY_USED')
  now = 1200
  assert.throws(() => registry.consume('roll-1', { campaignId: 'ROOM', actorId: 'hero', idempotencyKey: 'turn-1' }), (error) => error.code === 'ROLL_NOT_FOUND')
})

test('параметры проверки закрепляются серверным check_id и не заменяются клиентом', () => {
  const registry = new RollRegistry({
    diceService: new DiceService({ rng: new SequenceDiceRng([12]), idFactory: () => 'roll-bound' }),
    checkIdFactory: () => 'check-1',
  })
  registry.registerCheck({ campaignId: 'ROOM', actorId: 'hero', label: 'Скрытность', modifier: 3, difficulty: 15, ability: 'dex' })
  const result = registry.issue({ checkId: 'check-1', campaignId: 'ROOM', actorId: 'hero', label: 'Подмена', modifier: 99, difficulty: 1, ability: 'str' })
  assert.equal(result.purpose, 'Скрытность')
  assert.equal(result.modifier, 3)
  assert.equal(result.difficulty, 15)
  assert.equal(result.ability, 'dex')
  assert.equal(result.success, true)
  assert.throws(() => registry.issue({ checkId: 'check-1', campaignId: 'ROOM', actorId: 'hero' }), (error) => error.code === 'CHECK_NOT_FOUND')
})

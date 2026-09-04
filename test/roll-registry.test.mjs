import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { RollRegistry } from '../server/roll-registry.mjs'

test('потеря ответа на выдачу кости не создаёт новый бросок, в том числе после перезапуска', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'skazanie-check-retry-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const options = { diceService: new DiceService({ rng: new SequenceDiceRng([17]) }), storageFile: join(directory, 'rolls.json') }
  const registry = new RollRegistry(options)
  const check = registry.registerCheck({ campaignId: 'ROOM', actorId: 'hero', context: { kind: 'free_action' } })
  const request = { checkId: check.check_id, campaignId: 'ROOM', actorId: 'hero' }
  const rolled = registry.issue(request)
  assert.deepEqual(registry.issue(request), rolled)
  const reopened = new RollRegistry(options)
  assert.deepEqual(reopened.issue(request), rolled)
  assert.throws(() => reopened.issue({ ...request, actorId: 'other' }), { code: 'CHECK_FORBIDDEN' })
  assert.throws(() => reopened.consume(rolled.roll_id, {
    campaignId: 'ROOM', actorId: 'hero', idempotencyKey: 'wrong',
    validateContext: () => { throw new Error('Другая заявка') },
  }), /Другая заявка/u)
  assert.equal(reopened.consume(rolled.roll_id, { campaignId: 'ROOM', actorId: 'hero', idempotencyKey: 'right' }).roll_id, rolled.roll_id)
})

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
  assert.deepEqual(registry.issue({ checkId: 'check-1', campaignId: 'ROOM', actorId: 'hero', modifier: 99, difficulty: 1 }), result)
})

test('выданный и уже использованный roll_id переживает перезапуск процесса', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'skazanie-roll-registry-'))
  const storageFile = join(directory, 'rolls.json')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const options = {
    diceService: new DiceService({ rng: new SequenceDiceRng([17]), idFactory: () => 'durable-roll' }),
    storageFile,
    now: () => 1_000,
  }
  const first = new RollRegistry(options)
  first.issue({ campaignId: 'ROOM', actorId: 'hero', label: 'История', modifier: 2, difficulty: 15 })
  first.consume('durable-roll', { campaignId: 'ROOM', actorId: 'hero', idempotencyKey: 'turn-1' })

  const reopened = new RollRegistry(options)
  assert.equal(reopened.consume('durable-roll', { campaignId: 'ROOM', actorId: 'hero', idempotencyKey: 'turn-1' }).total, 19)
  assert.throws(
    () => reopened.consume('durable-roll', { campaignId: 'ROOM', actorId: 'hero', idempotencyKey: 'turn-2' }),
    (error) => error.code === 'ROLL_ALREADY_USED',
  )
})

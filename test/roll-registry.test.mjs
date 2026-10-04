import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { RollRegistry } from '../server/roll-registry.mjs'

test('выданную кость нельзя отменить редактированием, даже до применения результата и после рестарта', () => {
  const directory = mkdtempSync(join(tmpdir(), 'skazanie-edit-roll-'))
  const options = { diceService: new DiceService({ rng: new SequenceDiceRng([1]) }), storageFile: join(directory, 'rolls.json') }
  const registry = new RollRegistry(options)
  const check = registry.registerCheck({ campaignId: 'ROOM', actorId: 'hero' })
  const request = { checkId: check.check_id, campaignId: 'ROOM', actorId: 'hero' }
  const roll = registry.issue(request)
  assert.throws(() => registry.invalidateCheck(check.check_id, request), { code: 'CHECK_ALREADY_ROLLED' })
  const restarted = new RollRegistry(options)
  assert.throws(() => restarted.invalidateCheck(check.check_id, request), { code: 'CHECK_ALREADY_ROLLED' })
  assert.deepEqual(restarted.issue(request), roll)
  assert.equal(restarted.consume(roll.roll_id, { ...request, idempotencyKey: 'resolve' }).roll_id, roll.roll_id)
})

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
  const check = registry.registerCheck({ campaignId: 'ROOM', actorId: 'hero', label: 'Атака', modifier: 4, difficulty: 15 })
  const issued = registry.issue({ checkId: check.check_id, campaignId: 'ROOM', actorId: 'hero' })
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
  const check = first.registerCheck({ campaignId: 'ROOM', actorId: 'hero', label: 'История', modifier: 2, difficulty: 15 })
  first.issue({ checkId: check.check_id, campaignId: 'ROOM', actorId: 'hero' })
  first.consume('durable-roll', { campaignId: 'ROOM', actorId: 'hero', idempotencyKey: 'turn-1' })

  const reopened = new RollRegistry(options)
  assert.equal(reopened.consume('durable-roll', { campaignId: 'ROOM', actorId: 'hero', idempotencyKey: 'turn-1' }).total, 19)
  assert.throws(
    () => reopened.consume('durable-roll', { campaignId: 'ROOM', actorId: 'hero', idempotencyKey: 'turn-2' }),
    (error) => error.code === 'ROLL_ALREADY_USED',
  )
})

// Аудит PR #131, SEC-01: механическая кость выдаётся только под объявленную
// проверку, а ничейная запись механикой не потребляется.
test('кость без карточки проверки не выдаётся, и параметры клиента её не создают', () => {
  const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([20]) }) })
  for (const request of [
    { campaignId: 'ROOM', actorId: 'hero' },
    { campaignId: 'ROOM', actorId: 'hero', label: 'Сила', modifier: 12, difficulty: 5 },
    { checkId: '', check_id: null, campaignId: 'ROOM', actorId: 'hero' },
  ]) {
    assert.throws(() => registry.issue(request), { code: 'CHECK_REQUIRED' })
  }
  assert.equal(registry.rolls.size, 0, 'отказ не оставляет записи в реестре')
  assert.throws(() => registry.issue({ checkId: 'missing', campaignId: 'ROOM', actorId: 'hero' }), { code: 'CHECK_NOT_FOUND' })
})

test('ничейная запись из прежнего durable-файла механикой не потребляется', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'skazanie-roll-unbound-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const storageFile = join(directory, 'rolls.json')
  const roll = (id, consumedBy = null) => [id, {
    result: { roll_id: id, dice: [20], kept: 20, modifier: 0, total: 20, difficulty: 10, success: true, label: 'Проверка', ability: null },
    campaign_id: 'ROOM', actor_id: 'hero', expires_at: 10_000, consumed_by: consumedBy,
  }]
  // Записи до исправления: у привязанной кости нет поля `check_id`, связь
  // хранит только карточка (`issued_roll_id`).
  writeFileSync(storageFile, JSON.stringify({
    schema_version: 1,
    rolls: [roll('generic-roll'), roll('generic-used', 'turn-old'), roll('legacy-bound')],
    checks: [['legacy-check', {
      check_id: 'legacy-check', campaign_id: 'ROOM', actor_id: 'hero', label: 'Проверка', modifier: 0, difficulty: 10,
      ability: null, advantage: false, disadvantage: false, visibility: 'public', expires_at: 10_000, issued_roll_id: 'legacy-bound',
    }]],
  }), 'utf8')
  const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([1]) }), storageFile, now: () => 1_000 })
  const scope = { campaignId: 'ROOM', actorId: 'hero' }

  assert.throws(() => registry.consume('generic-roll', { ...scope, idempotencyKey: 'turn-1' }), { code: 'ROLL_UNBOUND' })
  // Отказ не помечает кость использованной: повтор отвечает тем же отказом.
  assert.throws(() => registry.consume('generic-roll', { ...scope, idempotencyKey: 'turn-1' }), { code: 'ROLL_UNBOUND' })
  // Уже потреблённая до исправления запись отдаёт прежний commit только тому
  // же ключу; новое потребление по-прежнему запрещено.
  assert.equal(registry.consume('generic-used', { ...scope, idempotencyKey: 'turn-old' }).roll_id, 'generic-used')
  assert.throws(() => registry.consume('generic-used', { ...scope, idempotencyKey: 'turn-2' }), { code: 'ROLL_ALREADY_USED' })
  // Привязанная кость того времени по-прежнему исполняет свою проверку.
  assert.equal(registry.consume('legacy-bound', { ...scope, idempotencyKey: 'turn-3' }).roll_id, 'legacy-bound')
})

// Аудит PR #131, SEC-04: `consume` — резерв до исхода commit. Несостоявшийся
// commit возвращает ту же кость, состоявшийся закрепляет её за своим ключом.
test('резерв броска без commit снимается, а с commit остаётся за своим ключом', () => {
  const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([3, 18]) }) })
  const scope = { campaignId: 'ROOM', actorId: 'hero' }
  const failedCheck = registry.registerCheck({ ...scope, label: 'Атлетика', modifier: 2, difficulty: 12 })
  const failedRoll = registry.issue({ checkId: failedCheck.check_id, ...scope })

  registry.consume(failedRoll.roll_id, { ...scope, idempotencyKey: 'turn-failed' })
  assert.throws(() => registry.consume(failedRoll.roll_id, { ...scope, idempotencyKey: 'turn-other' }), { code: 'ROLL_ALREADY_USED' })
  assert.equal(registry.finishReservation(failedRoll.roll_id, { idempotencyKey: 'turn-failed', committed: false }), true)
  // Кость та же — переброса нет; повторно выдаётся она же.
  assert.deepEqual(registry.issue({ checkId: failedCheck.check_id, ...scope }), failedRoll)
  assert.equal(registry.consume(failedRoll.roll_id, { ...scope, idempotencyKey: 'turn-other' }).kept, failedRoll.kept)
  registry.finishReservation(failedRoll.roll_id, { idempotencyKey: 'turn-other', committed: true })
  assert.throws(() => registry.consume(failedRoll.roll_id, { ...scope, idempotencyKey: 'turn-failed' }), { code: 'ROLL_ALREADY_USED' })
  // Тот же ключ после commit по-прежнему получает прежний бросок.
  assert.equal(registry.consume(failedRoll.roll_id, { ...scope, idempotencyKey: 'turn-other' }).roll_id, failedRoll.roll_id)

  // Чужой ключ резерв не снимает.
  const check = registry.registerCheck({ ...scope, label: 'Скрытность', difficulty: 10 })
  const roll = registry.issue({ checkId: check.check_id, ...scope })
  registry.consume(roll.roll_id, { ...scope, idempotencyKey: 'turn-a' })
  assert.equal(registry.finishReservation(roll.roll_id, { idempotencyKey: 'turn-b', committed: false }), false)
  assert.throws(() => registry.consume(roll.roll_id, { ...scope, idempotencyKey: 'turn-b' }), { code: 'ROLL_ALREADY_USED' })
})

test('резерв не снимается, пока его держит другой запрос того же ключа', () => {
  const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([11]) }) })
  const scope = { campaignId: 'ROOM', actorId: 'hero' }
  const check = registry.registerCheck({ ...scope, label: 'Проверка', difficulty: 10 })
  const roll = registry.issue({ checkId: check.check_id, ...scope })
  // Два запроса одного ключа (повтор после таймаута клиента) держат резерв.
  registry.consume(roll.roll_id, { ...scope, idempotencyKey: 'turn-1' })
  registry.consume(roll.roll_id, { ...scope, idempotencyKey: 'turn-1' })
  // Первый упал до commit — второй ещё может закоммитить, кость не отпускаем.
  assert.equal(registry.finishReservation(roll.roll_id, { idempotencyKey: 'turn-1', committed: false }), false)
  assert.throws(() => registry.consume(roll.roll_id, { ...scope, idempotencyKey: 'turn-2' }), { code: 'ROLL_ALREADY_USED' })
  assert.equal(registry.finishReservation(roll.roll_id, { idempotencyKey: 'turn-1', committed: false }), true)
  assert.equal(registry.consume(roll.roll_id, { ...scope, idempotencyKey: 'turn-2' }).roll_id, roll.roll_id)
})

test('после перезапуска снимаются только резервы без commit', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'skazanie-roll-orphan-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let rollId = 0
  const options = {
    diceService: new DiceService({ rng: new SequenceDiceRng([5, 15, 9, 12]), idFactory: () => `orphan-roll-${++rollId}` }),
    storageFile: join(directory, 'rolls.json'),
    now: () => 1_000,
  }
  const scope = { campaignId: 'ROOM', actorId: 'hero' }
  const first = new RollRegistry(options)
  const rolls = ['crashed', 'committed', 'unknown', 'burned'].map((name) => {
    const check = first.registerCheck({ ...scope, label: name, difficulty: 10 })
    const roll = first.issue({ checkId: check.check_id, ...scope })
    first.consume(roll.roll_id, { ...scope, idempotencyKey: `turn-${name}` })
    return roll
  })
  // Запрос завершился без commit по существу (кость подали не к той заявке):
  // такой исход окончателен и перезапуском не пересматривается.
  first.finishReservation(rolls[3].roll_id, { idempotencyKey: 'turn-burned', committed: true })
  // Процесс остановился между consume и исходом остальных: держатели не сняты.
  const restarted = new RollRegistry(options)
  const released = await restarted.releaseOrphanReservations(async (campaignId, key) => {
    assert.equal(campaignId, 'ROOM')
    if (key === 'turn-unknown') throw new Error('журнал не прочитан')
    return key === 'turn-committed'
  })
  assert.deepEqual(released, [rolls[0].roll_id])
  assert.equal(restarted.consume(rolls[0].roll_id, { ...scope, idempotencyKey: 'turn-retry' }).kept, rolls[0].kept)
  for (const kept of rolls.slice(1)) {
    assert.throws(() => restarted.consume(kept.roll_id, { ...scope, idempotencyKey: 'turn-retry' }), { code: 'ROLL_ALREADY_USED' })
  }
  // Закреплённый по журналу резерв повторной сверки не требует, неизвестный — ждёт её.
  assert.equal(restarted.rolls.get(rolls[1].roll_id).commit_pending, undefined)
  assert.equal(restarted.rolls.get(rolls[2].roll_id).commit_pending, true)
  // Новое потребление записано на диск: прежний ключ его не перехватит.
  const again = new RollRegistry(options)
  assert.throws(() => again.consume(rolls[0].roll_id, { ...scope, idempotencyKey: 'turn-crashed' }), { code: 'ROLL_ALREADY_USED' })
})

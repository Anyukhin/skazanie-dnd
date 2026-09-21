import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `ray-enfeeblement-${++id}`,
    now: () => '2026-09-19T12:00:00.000Z',
  })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

function state() {
  const cells = Array.from({ length: 48 }, (_, index) => ({
    x: index % 12,
    y: Math.floor(index / 12),
    type: 'floor',
    revealed: true,
  }))
  return normalizeCampaignState({
    sessionCode: 'RAY-ENFEEBLEMENT',
    partyMemberIds: ['mage'],
    players: [{
      id: 'mage',
      character: 'Маг',
      characterClass: 'wizard',
      level: 9,
      hp: 40,
      maxHp: 40,
      armor: 13,
      speed: 30,
      proficiency: 4,
      abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 },
      inventory: [],
      x: 1,
      y: 1,
    }],
    enemies: [{
      id: 'brute',
      name: 'Громила',
      creature_type: 'humanoid',
      hp: 100,
      maxHp: 100,
      armor: 10,
      speed: 30,
      proficiency: 2,
      abilities: { str: 16, dex: 10, con: 10, int: 8, wis: 8, cha: 8 },
      x: 5,
      y: 1,
      alive: true,
    }],
    scene: { turn: 1, cells },
    mechanics: {
      resources: { mage: { spell_slots_2: { current: 3, max: 3 } } },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'brute', total: 10 }],
        action_economy: {
          mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          brute: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function cast(initial, commandId, attackRoll) {
  return resolveCommand(authoritative({
    command_type: 'CastSpell',
    command_id: commandId,
    actor_id: 'mage',
    spell_id: 'ray-of-enfeeblement',
    target_id: 'brute',
  }), initial, options(dice([attackRoll])))
}

function endTurn(current, actorId, values = [], commandId = `${actorId}-end`) {
  return resolveCommand(authoritative({ command_type: 'EndTurn', command_id: commandId, actor_id: actorId }), current, options(dice(values)))
}

test('Луч слабости после попадания не делает первичный спасбросок и повторяет Телосложение в конце хода', () => {
  const initial = state()
  const castResult = cast(initial, 'ray-hit', 15)
  const attack = castResult.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attack.payload.hit, true)
  assert.equal(castResult.events.some((event) => event.event_type === 'SpellSavingThrowResolved'), false)
  const added = castResult.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'enfeebled')
  assert.ok(added)
  assert.equal(added.payload.repeat_save_timing, 'turn-end')
  assert.equal(added.payload.save_ability, 'con')
  assert.equal(added.payload.save_dc, 16)

  const afterCast = replayEvents(initial, castResult.events)
  const mageEnd = endTurn(afterCast, 'mage', [], 'mage-end-1')
  assert.equal(mageEnd.events.some((event) => event.event_type === 'SpellSavingThrowResolved'), false)
  const afterMage = replayEvents(afterCast, mageEnd.events)

  const failed = endTurn(afterMage, 'brute', [1], 'brute-end-fail')
  const failedSave = failed.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(failedSave.payload.trigger, 'turn-end-repeat')
  assert.equal(failedSave.payload.ability, 'con')
  assert.equal(failedSave.payload.saved, false)
  const afterFailed = replayEvents(afterMage, failed.events)
  assert.equal(afterFailed.mechanics.concentration.mage.effect_id, 'ray-of-enfeeblement:ray-hit')
  assert.ok(afterFailed.mechanics.conditions.brute.some((condition) => condition.id === 'enfeebled'))

  const mageEndAgain = endTurn(afterFailed, 'mage', [], 'mage-end-2')
  const afterMageAgain = replayEvents(afterFailed, mageEndAgain.events)
  const succeeded = endTurn(afterMageAgain, 'brute', [20], 'brute-end-success')
  const successSave = succeeded.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(successSave.payload.saved, true)
  assert.ok(succeeded.events.some((event) => event.event_type === 'ConcentrationEnded'
    && event.payload.effect_id === 'ray-of-enfeeblement:ray-hit'))
  const afterSuccess = replayEvents(afterMageAgain, succeeded.events)
  assert.equal(afterSuccess.mechanics.concentration.mage, undefined)
  assert.equal(afterSuccess.mechanics.conditions.brute?.some((condition) => condition.id === 'enfeebled'), false)
  assert.deepEqual(afterSuccess, succeeded.events.reduce((current, event) => applyGameEvent(current, event), afterMageAgain))
})

test('Промах Луча слабости не накладывает условие', () => {
  const initial = state()
  const castResult = cast(initial, 'ray-miss', 1)
  const attack = castResult.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attack.payload.hit, false)
  assert.equal(castResult.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'enfeebled'), false)
  assert.equal(castResult.events.some((event) => event.event_type === 'SpellSavingThrowResolved'), false)
  const after = replayEvents(initial, castResult.events)
  assert.equal(after.mechanics.concentration.mage.effect_id, 'ray-of-enfeeblement:ray-miss')
})

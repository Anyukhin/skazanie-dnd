import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function state() {
  const cells = Array.from({ length: 100 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'ENERVATION-EXACT', ruleset_id: 'dnd_5e_2014', partyMemberIds: ['caster'],
    players: [{ id: 'caster', character: 'Маг', characterClass: 'wizard', level: 12, hp: 50, maxHp: 50, armor: 14, proficiency: 4, abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory: [], x: 1, y: 1 }],
    enemies: [{ id: 'target', name: 'Цель', creature_type: 'humanoid', hp: 100, maxHp: 100, armor: 12, speed: 30, abilities: { dex: 10, con: 14 }, x: 3, y: 1, alive: true }],
    scene: { cells },
    mechanics: {
      resources: { caster: { spell_slots_6: { current: 1, max: 1 } } },
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'target', total: 10 }], action_economy: { caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }, target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

function cast(values) {
  let id = 0
  const diceService = new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `enervation-exact-${++id}`, now: () => '2026-09-22T12:00:00.000Z' })
  return resolveCommand({ command_type: 'CastSpell', command_id: `enervation-exact-${values[0]}`, actor_id: 'caster', spell_id: 'enervation', target_id: 'target', target_ids: ['target'], slot_level: 6, casting_resource: 'spell_slots_6', server_authoritative: true }, state(), { diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
}

test('успешный save бросает отдельные 3d8 на ячейке 6 и не создаёт эффект', () => {
  const result = cast([20, 6, 1, 1])
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  const damageRoll = result.rolls.find((roll) => roll.purpose === 'spell_save_damage:enervation')
  assert.equal(result.events.find((event) => event.event_type === 'SpellSavingThrowResolved').payload.saved, true)
  assert.equal(damageRoll.expression, '3d8')
  assert.equal(damageRoll.total, 8)
  assert.equal(damage.payload.raw_amount, 8)
  assert.equal(result.rolls.some((roll) => roll.purpose === 'spell_damage:enervation'), false)
  assert.equal(result.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'enervated'), false)
  assert.ok(result.events.some((event) => event.event_type === 'ConcentrationEnded' && event.payload.reason === 'save-success'))
  assert.equal(replayEvents(state(), result.events).mechanics.concentration.caster, undefined)
})

test('провал бросает полный 5d8 upcast и оставляет только маркер без автоматического recurring damage', () => {
  const result = cast([1, 4, 5, 6, 7, 8])
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  const damageRoll = result.rolls.find((roll) => roll.purpose === 'spell_damage:enervation')
  const condition = result.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'enervated')
  assert.equal(result.events.find((event) => event.event_type === 'SpellSavingThrowResolved').payload.saved, false)
  assert.equal(damageRoll.expression, '5d8')
  assert.equal(damageRoll.total, 30)
  assert.equal(damage.payload.raw_amount, 30)
  assert.ok(condition)
  assert.equal(condition.payload.recurring_damage, undefined)
})

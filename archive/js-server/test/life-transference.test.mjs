import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `lt-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

function field({ casterClass = 'cleric', allyHp = 10, defenses = {} } = {}) {
  const cells = Array.from({ length: 96 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'LT-1',
    partyMemberIds: ['cleric', 'ally'],
    players: [
      { id: 'cleric', character: 'Жрец', characterClass: casterClass, level: 12, hp: 60, maxHp: 60, armor: 16, speed: 30, proficiency: 4, abilities: { str: 12, dex: 12, con: 14, int: 12, wis: 18, cha: 12 }, inventory: [], x: 1, y: 2 },
      { id: 'ally', character: 'Бор', characterClass: 'fighter', level: 9, hp: allyHp, maxHp: 60, armor: 17, speed: 30, proficiency: 4, abilities: { str: 18, dex: 12, con: 16, int: 8, wis: 10, cha: 10 }, inventory: [], x: 3, y: 2 },
    ],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 90, maxHp: 90, armor: 12, speed: 30, abilities: { str: 14, dex: 10, con: 12, int: 8, wis: 8, cha: 8 }, x: 10, y: 2, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      defenses,
      resources: { cleric: Object.fromEntries([1, 2, 3, 4, 5, 6].map((slot) => [`spell_slots_${slot}`, { current: 3, max: 3 }])) },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'cleric', total: 20 }, { actor_id: 'ally', total: 15 }, { actor_id: 'brute', total: 8 }],
        action_economy: Object.fromEntries(['cleric', 'ally', 'brute'].map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])),
      },
    },
  })
}

const transfer = (state, values) => resolveCommand(
  authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'life-transference', target_id: 'ally' }),
  state,
  options(dice(values)),
)

test('Переливание жизни бьёт заклинателя и лечит союзника вдвое', () => {
  const state = field()
  const result = transfer(state, [4, 4, 4, 4, 18])
  const cost = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(cost.payload.self_inflicted, true, 'платит сам заклинатель')
  assert.equal(cost.payload.damage_type, 'necrotic')
  assert.equal(cost.payload.applied_amount, 16)

  const healing = result.events.find((event) => event.event_type === 'HealingApplied')
  assert.equal(healing.payload.requested_amount, 32, 'союзнику вдвое больше отнятого')
  assert.equal(healing.payload.applied_amount, 32)

  const after = replayEvents(state, result.events)
  assert.equal(after.players.find((player) => player.id === 'cleric').hp, 44)
  assert.equal(after.players.find((player) => player.id === 'ally').hp, 42)
})

test('сопротивление некротике уменьшает и цену, и результат', () => {
  const result = transfer(field({ defenses: { cleric: { resistances: ['necrotic'] } } }), [4, 4, 4, 4, 18])
  assert.equal(result.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount, 8)
  assert.equal(result.events.find((event) => event.event_type === 'HealingApplied').payload.requested_amount, 16, 'лечение считается от фактически отнятого')
})

test('лечение не переливает через максимум', () => {
  const result = transfer(field({ allyHp: 55 }), [4, 4, 4, 4, 18])
  const healing = result.events.find((event) => event.event_type === 'HealingApplied')
  assert.equal(healing.payload.requested_amount, 32)
  assert.equal(healing.payload.applied_amount, 5, 'до максимума оставалось пять')
  assert.equal(healing.payload.hp_after, 60)
})

test('Верный страж появляется отдельной фишкой', () => {
  const result = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'mordenkainen-s-faithful-hound', to: { x: 4, y: 2 } }),
    field({ casterClass: 'wizard' }),
    options(dice()),
  )
  const summoned = result.events.find((event) => event.event_type === 'SummonedCreatureCreated')
  assert.ok(summoned, 'страж обязан появиться на поле')
  assert.equal(summoned.payload.summon.attack_profile.damage_expression, '4d8')
  assert.equal(summoned.payload.summon.attack_profile.damage_type, 'piercing')
})

test('Стрелы стражи бьют вошедшего в область', () => {
  const state = field({ casterClass: 'ranger' })
  const placed = replayEvents(state, resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'cordon-of-arrows', to: { x: 1, y: 2 } }),
    state,
    options(dice()),
  ).events)
  const effect = placed.mechanics.active_effects.find((candidate) => candidate.spell_id === 'cordon-of-arrows')
  assert.equal(effect.damage, '1d6')
  assert.equal(effect.trigger_on_enter, true)
  assert.equal(effect.save_ability, 'dex')
})

test('Шаг Ашардалона ускоряет и снимает атаки по возможности', () => {
  const state = field({ casterClass: 'ranger' })
  const after = replayEvents(state, resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'ashardalon-s-stride', target_id: 'cleric' }),
    state,
    options(dice()),
  ).events)
  const ids = after.mechanics.conditions.cleric.map((condition) => String(condition.id))
  assert.ok(ids.includes('ashardalon-s-stride'))
  assert.ok(ids.includes('disengaged'))
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { RulesValidationError, applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `aura-life-roll-${++id}`,
    now: () => '2026-07-18T16:00:00.000Z',
  })
}

function fixture({ fallenHp = 20, farHp = 20 } = {}) {
  const cells = Array.from({ length: 30 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  const conditions = {}
  const savingThrows = {}
  if (fallenHp === 0) {
    conditions.fallen = [{ id: 'unconscious' }]
    savingThrows.fallen = { successes: 0, failures: 1, stable: false }
  }
  if (farHp === 0) {
    conditions.far = [{ id: 'unconscious' }]
    savingThrows.far = { successes: 0, failures: 0, stable: false }
  }
  return normalizeCampaignState({
    sessionCode: 'AURA-OF-LIFE',
    partyMemberIds: ['caster', 'fallen', 'far'],
    players: [
      { id: 'caster', character: 'Иара', characterClass: 'cleric', level: 7, hp: 32, maxHp: 32, armor: 17, speed: 30, proficiency: 3, abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 18, cha: 10 }, x: 1, y: 1, inventory: [] },
      { id: 'fallen', character: 'Кел', characterClass: 'fighter', level: 7, hp: fallenHp, maxHp: 30, armor: 17, speed: 30, proficiency: 3, abilities: { str: 16, dex: 12, con: 16, int: 10, wis: 10, cha: 10 }, x: 2, y: 1, inventory: [] },
      { id: 'far', character: 'Рен', characterClass: 'rogue', level: 7, hp: farHp, maxHp: 25, armor: 15, speed: 30, proficiency: 3, abilities: { str: 10, dex: 18, con: 12, int: 12, wis: 12, cha: 10 }, x: 8, y: 1, inventory: [] },
    ],
    enemies: [{ id: 'enemy', name: 'Некромант', hp: 40, maxHp: 40, armor: 13, speed: 30, abilities: { str: 10, dex: 12, con: 14, int: 16, wis: 12, cha: 14 }, x: 2, y: 2, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      positions: { caster: { x: 1, y: 1 }, fallen: { x: 2, y: 1 }, far: { x: 8, y: 1 }, enemy: { x: 2, y: 2 } },
      conditions,
      death: { saving_throws: savingThrows, heroes: {}, campaign_status: 'active' },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 18 }, { actor_id: 'fallen', total: 15 }, { actor_id: 'far', total: 12 }, { actor_id: 'enemy', total: 8 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          fallen: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          far: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const applyAll = (state, events) => events.reduce((current, event) => applyGameEvent(current, event), state)

function castAura(initial) {
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'aura-of-life', target_id: 'caster', server_authoritative: true }, initial, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
  return { result, state: applyAll(initial, result.events) }
}

test('Аура жизни поднимает союзника с 0 ОЗ до death save в начале хода', () => {
  const initial = fixture({ fallenHp: 0 })
  const cast = castAura(initial)
  assert.ok(cast.state.mechanics.conditions.caster.some((condition) => condition.id === 'aura-of-life'))
  const turn = resolveCommand({ command_type: 'EndTurn', actor_id: 'caster', server_authoritative: true }, cast.state, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
  assert.deepEqual(turn.events.map((event) => event.event_type), ['TurnEnded', 'TurnStarted', 'HealingApplied'])
  assert.equal(turn.events.some((event) => event.event_type === 'DeathSavingThrowRolled'), false)
  const after = applyAll(cast.state, turn.events)
  assert.equal(after.players.find((hero) => hero.id === 'fallen').hp, 1)
  assert.equal(after.mechanics.death.saving_throws.fallen, undefined)
  assert.equal(after.mechanics.conditions.fallen.some((condition) => condition.id === 'unconscious'), false)
  assert.deepEqual(replayEvents(cast.state, turn.events), after)
})

test('Аура жизни даёт сопротивление некротическому урону только союзникам внутри 30 футов', () => {
  const cast = castAura(fixture())
  const nearDamage = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'fallen', amount: 9, damage_type: 'necrotic' }, cast.state, { diceService: dice() })
  const nearPayload = nearDamage.events.find((event) => event.event_type === 'DamageApplied').payload
  assert.equal(nearPayload.resistant, true)
  assert.equal(nearPayload.aura_of_life_source, 'caster')
  assert.equal(nearPayload.applied_amount, 4)

  const farDamage = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'far', amount: 9, damage_type: 'necrotic' }, cast.state, { diceService: dice() })
  assert.equal(farDamage.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount, 9)

  const enemyDamage = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'caster', target_id: 'enemy', amount: 9, damage_type: 'necrotic' }, cast.state, { diceService: dice() })
  assert.equal(enemyDamage.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount, 9)

  cast.state.mechanics.positions.fallen = { x: 9, y: 1 }
  cast.state.players.find((hero) => hero.id === 'fallen').x = 9
  const movedAway = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'fallen', amount: 9, damage_type: 'necrotic' }, cast.state, { diceService: dice() })
  assert.equal(movedAway.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount, 9)

  const unplaced = structuredClone(cast.state)
  delete unplaced.mechanics.positions.fallen
  delete unplaced.players.find((hero) => hero.id === 'fallen').x
  delete unplaced.players.find((hero) => hero.id === 'fallen').y
  const withoutCoordinates = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'fallen', amount: 9, damage_type: 'necrotic' }, unplaced, { diceService: dice() })
  assert.equal(withoutCoordinates.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount, 9)
})

test('Аура жизни блокирует доверенное уменьшение максимума ОЗ только внутри радиуса', () => {
  const cast = castAura(fixture())
  assert.throws(
    () => resolveCommand({ command_type: 'ReduceHitPointMaximum', actor_id: 'enemy', target_id: 'fallen', amount: 5 }, cast.state, { diceService: dice() }),
    (error) => error instanceof RulesValidationError && error.code === 'MAX_HP_REDUCTION_FORBIDDEN',
  )

  const protectedResult = resolveCommand({ command_type: 'ReduceHitPointMaximum', actor_id: 'enemy', target_id: 'fallen', amount: 5 }, cast.state, {
    diceService: dice(), context: { isAdmin: true },
  })
  assert.deepEqual(protectedResult.events.map((event) => event.event_type), ['HitPointMaximumReductionPrevented'])
  const protectedState = applyAll(cast.state, protectedResult.events)
  assert.equal(protectedState.players.find((hero) => hero.id === 'fallen').maxHp, 30)

  const reduced = resolveCommand({ command_type: 'ReduceHitPointMaximum', actor_id: 'enemy', target_id: 'far', amount: 5 }, cast.state, {
    diceService: dice(), context: { isAdmin: true },
  })
  assert.deepEqual(reduced.events.map((event) => event.event_type), ['HitPointMaximumReduced'])
  const reducedState = applyAll(cast.state, reduced.events)
  assert.equal(reducedState.players.find((hero) => hero.id === 'far').maxHp, 20)
  assert.equal(reducedState.players.find((hero) => hero.id === 'far').hp, 20)
  assert.deepEqual(replayEvents(cast.state, reduced.events), reducedState)
})

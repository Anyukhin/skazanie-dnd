import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

const authoritative = (command) => ({ ...command, server_authoritative: true })
const dice = (values, prefix) => new DiceService({
  rng: new SequenceDiceRng(values),
  idFactory: (() => { let n = 0; return () => `${prefix}-${++n}` })(),
  now: () => '2026-09-22T12:00:00.000Z',
})
const options = (values, prefix) => ({ diceService: dice(values, prefix), context: { serverAuthoritativeCombat: true, isAdmin: true } })

function field() {
  const cells = Array.from({ length: 12 * 5 }, (_, index) => ({ x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'VITRIOLIC-REGRESSION',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Маг', characterClass: 'wizard', level: 9, hp: 60, maxHp: 60, armor: 13, speed: 30, proficiency: 4, abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory: [], x: 0, y: 0 }],
    enemies: [{ id: 'foe', name: 'Цель', creature_type: 'humanoid', hp: 100, maxHp: 100, armor: 13, speed: 30, abilities: { str: 12, dex: 10, con: 12, int: 10, wis: 8, cha: 8 }, x: 5, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: { combat: {
      active: true, round: 1, active_index: 0,
      initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'foe', total: 8 }],
      action_economy: {
        mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
      },
    } },
  })
}

function fieldVariant({ hp = 100, damageResistances = [] } = {}) {
  const state = field()
  state.enemies[0].hp = hp
  state.enemies[0].maxHp = Math.max(state.enemies[0].maxHp, hp)
  state.enemies[0].damage_resistances = damageResistances
  return state
}

test('Едкий шар наносит дополнительные5к4 в конце следующего хода цели', () => {
  const initial = field()
  const cast = resolveCommand(authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'vitriolic-sphere', to: { x: 5, y: 1 } }), initial, options([...Array.from({ length: 10 }, () => 4), 1], 'cast'))
  const condition = cast.events.find((event) => event.event_type === 'ConditionAdded')?.payload
  assert.equal(condition?.recurring_damage, '5d4')
  assert.equal(condition?.recurring_damage_timing, 'turn-end')

  const afterCast = replayEvents(initial, cast.events)
  const foeTurn = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'mage' }), afterCast, options([], 'caster-end'))
  assert.equal(foeTurn.events.some((event) => event.event_type === 'DamageApplied' && event.payload.spell_id === 'vitriolic-sphere'), false)

  const duringFoeTurn = replayEvents(afterCast, foeTurn.events)
  const targetEnd = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'foe' }), duringFoeTurn, options([4, 4, 4, 4, 4], 'target-end'))
  const delayed = targetEnd.events.find((event) => event.event_type === 'DamageApplied' && event.payload.spell_id === 'vitriolic-sphere' && event.payload.recurring === true)
  assert.ok(delayed)
  assert.equal(delayed.payload.trigger, 'turn-end')
  assert.equal(delayed.payload.raw_amount, 20)
})

test('Отложенная кислота учитывает сопротивление, нулевые хиты, успешный спасбросок и replay', () => {
  const resistant = fieldVariant({ damageResistances: ['acid'] })
  const cast = resolveCommand(authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'vitriolic-sphere', to: { x: 5, y: 1 } }), resistant, options([...Array.from({ length: 10 }, () => 4), 1], 'resist-cast'))
  const afterCast = replayEvents(resistant, cast.events)
  const casterEnd = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'mage' }), afterCast, options([], 'resist-caster-end'))
  const targetState = replayEvents(afterCast, casterEnd.events)
  const delayed = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'foe' }), targetState, options([4, 4, 4, 4, 4], 'resist-target-end'))
  const damage = delayed.events.find((event) => event.event_type === 'DamageApplied' && event.payload.spell_id === 'vitriolic-sphere')
  assert.equal(damage.payload.raw_amount, 20)
  assert.equal(damage.payload.applied_amount, 10)
  assert.equal(damage.payload.resistant, true)
  const resistantAfter = replayEvents(targetState, delayed.events)
  assert.deepEqual(replayEvents(targetState, delayed.events), resistantAfter)

  const zero = fieldVariant({ hp: 50 })
  const zeroCast = resolveCommand(authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'vitriolic-sphere', to: { x: 5, y: 1 } }), zero, options([...Array.from({ length: 10 }, () => 4), 1], 'zero-cast'))
  const zeroAfterCast = replayEvents(zero, zeroCast.events)
  const zeroCasterEnd = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'mage' }), zeroAfterCast, options([], 'zero-caster-end'))
  const zeroTargetState = replayEvents(zeroAfterCast, zeroCasterEnd.events)
  const zeroEnd = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'foe' }), zeroTargetState, options([4, 4, 4, 4, 4], 'zero-target-end'))
  assert.ok(zeroEnd.events.some((event) => event.event_type === 'HitPointsReducedToZero' && event.target_ids?.[0] === 'foe'))
  const zeroAfter = replayEvents(zeroTargetState, zeroEnd.events)
  assert.equal(zeroAfter.enemies[0].hp, 0)
  assert.ok(zeroAfter.mechanics.conditions.foe.some((condition) => condition.id === 'unconscious'))
  assert.deepEqual(replayEvents(zeroTargetState, zeroEnd.events), zeroAfter)

  const saved = field()
  const saveCast = resolveCommand(authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'vitriolic-sphere', to: { x: 5, y: 1 } }), saved, options([...Array.from({ length: 10 }, () => 4), 20], 'saved-cast'))
  assert.equal(saveCast.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.spell_id === 'vitriolic-sphere'), false)
  assert.equal(saveCast.events.some((event) => event.event_type === 'DamageApplied' && event.payload.spell_id === 'vitriolic-sphere' && event.payload.recurring), false)
})

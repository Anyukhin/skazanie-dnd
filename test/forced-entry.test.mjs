import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `push-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

/** Заклинатель в (1,2), громила в (3,2): толчок отбросит его вправо. */
function field() {
  const cells = Array.from({ length: 96 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'PUSH-1',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', characterClass: 'wizard', level: 12, hp: 50, maxHp: 50, armor: 13, speed: 30, proficiency: 4, abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 16, cha: 12 }, inventory: [], x: 1, y: 2 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 90, maxHp: 90, armor: 13, speed: 30, abilities: { str: 8, dex: 8, con: 14, int: 8, wis: 8, cha: 8 }, x: 3, y: 2, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      resources: { mage: Object.fromEntries([1, 2, 3, 4, 5, 6].map((slot) => [`spell_slots_${slot}`, { current: 3, max: 3 }])) },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'brute', total: 8 }],
        action_economy: {
          mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          brute: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const cast = (state, spellId, values, extra = {}) => resolveCommand(
  authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: spellId, ...extra }),
  state,
  options(dice(values)),
)

/** Новый ход: первое заклинание уже потратило действие и держит концентрацию. */
const freshTurn = (state) => ({
  ...state,
  mechanics: {
    ...state.mechanics,
    concentration: {},
    combat: {
      ...state.mechanics.combat,
      action_economy: { ...state.mechanics.combat.action_economy, mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
    },
  },
})

test('толчок в стену огня поджигает отброшенного', () => {
  const state = field()
  // Стена встаёт поперёк на x = 5, громила стоит в (3,2) перед ней.
  const lit = replayEvents(state, cast(state, 'wall-of-fire', Array.from({ length: 12 }, () => 4), { to: { x: 5, y: 2 } }).events)
  assert.ok(lit.mechanics.active_effects.some((effect) => effect.spell_id === 'wall-of-fire'))

  // Волна грома отбрасывает на 10 футов от заклинателя — ровно в стену.
  // 2к8 грома, проваленный спасбросок, затем спасбросок от стены и её 5к8.
  const wave = cast(freshTurn(lit), 'thunderwave', [4, 4, 2, 3, 4, 4, 4, 4, 4], { to: { x: 3, y: 2 } })
  const moved = wave.events.find((event) => event.event_type === 'ActorMoved' && event.payload.forced_movement)
  assert.ok(moved, 'громилу обязано отбросить')
  assert.equal(moved.payload.to.x, 5, 'отброшен ровно в клетку стены')

  const burn = wave.events.find((event) => event.event_type === 'DamageApplied' && event.payload.spell_id === 'wall-of-fire')
  assert.ok(burn, 'стена обязана обжечь того, кого в неё втолкнули')
  assert.equal(burn.payload.damage_type, 'fire')
  assert.equal(wave.events.find((event) => event.event_type === 'SpellSavingThrowResolved' && event.payload.spell_id === 'wall-of-fire').payload.trigger, 'forced-entry')
})

test('толчок мимо области ничего не поджигает', () => {
  const state = field()
  const lit = replayEvents(state, cast(state, 'wall-of-fire', Array.from({ length: 12 }, () => 4), { to: { x: 12, y: 2 } }).events)
  const wave = cast(freshTurn(lit), 'thunderwave', [4, 4, 2], { to: { x: 3, y: 2 } })
  assert.ok(wave.events.some((event) => event.event_type === 'ActorMoved' && event.payload.forced_movement))
  assert.equal(wave.events.some((event) => event.event_type === 'DamageApplied' && event.payload.spell_id === 'wall-of-fire'), false)
})

test('удержавшийся на ногах в стену не летит', () => {
  const state = field()
  const lit = replayEvents(state, cast(state, 'wall-of-fire', Array.from({ length: 12 }, () => 4), { to: { x: 5, y: 2 } }).events)
  // Успешный спасбросок: урон вдвое, толчка нет.
  const wave = cast(freshTurn(lit), 'thunderwave', [4, 4, 20], { to: { x: 3, y: 2 } })
  assert.equal(wave.events.some((event) => event.event_type === 'ActorMoved'), false, 'спасбросок удержал на месте')
  assert.equal(wave.events.some((event) => event.event_type === 'DamageApplied' && event.payload.spell_id === 'wall-of-fire'), false)
})

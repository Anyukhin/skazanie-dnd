import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `area-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

function field({ casterClass = 'wizard', level = 12 } = {}) {
  const cells = Array.from({ length: 96 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'AREA-1',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', characterClass: casterClass, level, hp: 50, maxHp: 50, armor: 13, speed: 30, proficiency: 4, abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 16, cha: 12 }, inventory: [], x: 1, y: 2 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 90, maxHp: 90, armor: 13, speed: 30, abilities: { str: 16, dex: 8, con: 14, int: 8, wis: 8, cha: 8 }, x: 10, y: 2, alive: true }],
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
const areas = (state) => state.mechanics.active_effects.map((effect) => String(effect.spell_id))

/** Новый ход заклинателя: первое заклинание уже потратило действие. */
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

test('паутина остаётся на поле и помечена горючей', () => {
  const state = field()
  const after = replayEvents(state, cast(state, 'web', [2], { to: { x: 10, y: 2 } }).events)
  const web = after.mechanics.active_effects.find((effect) => effect.spell_id === 'web')
  assert.ok(web, 'паутина обязана остаться длящейся областью')
  assert.equal(web.flammable.damage, '2d4')
})

test('огонь выжигает паутину и обжигает того, кто в ней стоял', () => {
  const state = field()
  const woven = replayEvents(state, cast(state, 'web', [2], { to: { x: 10, y: 2 } }).events)
  assert.ok(areas(woven).includes('web'))

  // Огненный шар в ту же точку: 8к6 по громиле, затем выгорание паутины.
  const burn = cast(freshTurn(woven), 'fireball', [...Array.from({ length: 8 }, () => 4), 2, 3, 3, 3, 3], { to: { x: 10, y: 2 } })
  const removed = burn.events.find((event) => event.event_type === 'SpellAreaRemoved')
  assert.ok(removed, 'паутина обязана выгореть')
  assert.equal(removed.payload.reason, 'burned-away')
  assert.equal(removed.payload.spell_id, 'web')

  const burned = burn.events.find((event) => event.event_type === 'DamageApplied' && event.payload.area_burned)
  assert.ok(burned, 'стоявший в паутине получает урон от горения')
  assert.equal(burned.payload.damage_type, 'fire')
  const burnRoll = burn.rolls.find((roll) => roll.purpose === 'spell_area_burn:web')
  assert.equal(burnRoll.expression, '2d4', 'горит на 2к4, как написано в редакции')
  assert.equal(burned.payload.raw_amount, burnRoll.total)
  assert.equal(areas(replayEvents(woven, burn.events)).includes('web'), false, 'паутины больше нет')
})

test('огонь в стороне паутину не трогает', () => {
  const state = field()
  const woven = replayEvents(state, cast(state, 'web', [2], { to: { x: 10, y: 2 } }).events)
  const elsewhere = cast(freshTurn(woven), 'fireball', [...Array.from({ length: 8 }, () => 4), 2, 2, 2], { to: { x: 1, y: 5 } })
  assert.equal(elsewhere.events.some((event) => event.event_type === 'SpellAreaRemoved'), false)
  assert.ok(areas(replayEvents(woven, elsewhere.events)).includes('web'))
})

test('ледяной дождь гасит стену огня в своей области', () => {
  const state = field()
  const lit = replayEvents(state, cast(state, 'wall-of-fire', Array.from({ length: 12 }, () => 4), { to: { x: 10, y: 2 } }).events)
  assert.ok(lit.mechanics.active_effects.find((effect) => effect.spell_id === 'wall-of-fire')?.open_flame)

  const sleet = cast(freshTurn(lit), 'sleet-storm', [2, 2], { to: { x: 10, y: 2 } })
  const doused = sleet.events.find((event) => event.event_type === 'SpellAreaRemoved')
  assert.ok(doused, 'пламя обязано погаснуть')
  assert.equal(doused.payload.reason, 'doused')
  assert.equal(doused.payload.spell_id, 'wall-of-fire')

  const after = areas(replayEvents(lit, sleet.events))
  assert.equal(after.includes('wall-of-fire'), false, 'стены огня больше нет')
  assert.ok(after.includes('sleet-storm'), 'сам ледяной дождь остался')
})

test('ледяной дождь в стороне чужое пламя не гасит', () => {
  const state = field()
  const lit = replayEvents(state, cast(state, 'wall-of-fire', Array.from({ length: 12 }, () => 4), { to: { x: 10, y: 2 } }).events)
  const sleet = cast(freshTurn(lit), 'sleet-storm', [2, 2], { to: { x: 1, y: 5 } })
  assert.equal(sleet.events.some((event) => event.event_type === 'SpellAreaRemoved'), false)
  assert.ok(areas(replayEvents(lit, sleet.events)).includes('wall-of-fire'))
})

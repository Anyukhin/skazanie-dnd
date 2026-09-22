import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (values, prefix) => ({
  diceService: new DiceService({ rng: new SequenceDiceRng(values), idFactory: (() => { let n = 0; return () => `${prefix}-${++n}` })(), now: () => '2026-09-22T12:00:00.000Z' }),
  context: { serverAuthoritativeCombat: true, isAdmin: true },
})

function field() {
  const cells = Array.from({ length: 16 * 6 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  const players = ['mage', 'mage2', 'mage3'].map((id, index) => ({
    id, character: id, characterClass: 'wizard', level: 9, hp: 60, maxHp: 60, armor: 13, speed: 30, proficiency: 4,
    abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory: [], x: 1, y: 2 + index,
  }))
  return normalizeCampaignState({
    sessionCode: 'VITRIOLIC-COMPOSITION', partyMemberIds: players.map((actor) => actor.id), players,
    enemies: [{ id: 'foe', name: 'Цель', creature_type: 'humanoid', hp: 200, maxHp: 200, armor: 13, speed: 30, abilities: { str: 12, dex: 10, con: 12, int: 10, wis: 8, cha: 8 }, x: 5, y: 2, alive: true }],
    scene: { turn: 1, cells },
    mechanics: { resources: Object.fromEntries(players.map((actor) => [actor.id, { spell_slots_4: { current: 3, max: 3 } }])), combat: {
      active: true, round: 1, active_index: 0,
      initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'mage2', total: 19 }, { actor_id: 'mage3', total: 18 }, { actor_id: 'foe', total: 8 }],
      action_economy: Object.fromEntries([...players, { id: 'foe' }].map((actor) => [actor.id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])),
    } },
  })
}

const cast = (state, actor, spellId, to, values, prefix) => resolveCommand(authoritative({ command_type: 'CastSpell', actor_id: actor, spell_id: spellId, to }), state, options(values, prefix))
const endTurn = (state, actor, values, prefix) => resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: actor }), state, options(values, prefix))

test('Кислота Таши и два Едких шара сохраняют отдельные источники и моменты урона', () => {
  let state = field()
  state = replayEvents(state, cast(state, 'mage', 'tasha-s-caustic-brew', { x: 6, y: 2 }, [1], 'tasha').events)
  state = replayEvents(state, endTurn(state, 'mage', [], 'mage-end').events)
  state = replayEvents(state, cast(state, 'mage2', 'vitriolic-sphere', { x: 6, y: 2 }, [...Array.from({ length: 10 }, () => 4), 1], 'vitriolic-one').events)
  state = replayEvents(state, endTurn(state, 'mage2', [], 'mage2-end').events)
  state = replayEvents(state, cast(state, 'mage3', 'vitriolic-sphere', { x: 6, y: 2 }, [...Array.from({ length: 10 }, () => 4), 1], 'vitriolic-two').events)

  const active = state.mechanics.conditions.foe ?? []
  const acid = active.filter((condition) => condition.recurring_damage_type === 'acid')
  assert.equal(acid.length, 3, 'Tasha + два шара должны жить как три независимых эффекта')
  assert.ok(acid.some((condition) => condition.id === 'acid-covered'))
  const riders = acid.filter((condition) => condition.id === 'vitriolic-acid-covered')
  assert.equal(riders.length, 2)
  assert.notEqual(riders[0].effect_id, riders[1].effect_id)

  const foeTurn = endTurn(state, 'mage3', [4, 4], 'mage3-end')
  const startRiders = foeTurn.events.filter((event) => event.event_type === 'DamageApplied' && event.payload.spell_id === 'vitriolic-sphere')
  assert.equal(startRiders.length, 0, 'шара не должны срабатывать в начале хода')
  state = replayEvents(state, foeTurn.events)
  const targetEnd = endTurn(state, 'foe', Array.from({ length: 10 }, () => 4), 'foe-end')
  const delayed = targetEnd.events.filter((event) => event.event_type === 'DamageApplied' && event.payload.spell_id === 'vitriolic-sphere')
  assert.equal(delayed.length, 2, 'оба шара должны сработать независимо')
  assert.ok(delayed.every((event) => event.payload.trigger === 'turn-end' && event.payload.raw_amount === 20))
  const after = replayEvents(state, targetEnd.events)
  assert.equal((after.mechanics.conditions.foe ?? []).filter((condition) => condition.id === 'vitriolic-acid-covered').length, 0, 'оба однократных rider-а должны сняться')
  assert.equal((after.mechanics.conditions.foe ?? []).filter((condition) => condition.id === 'acid-covered').length, 1, 'кислота Таши не должна сниматься шаром')
  assert.deepEqual(replayEvents(state, targetEnd.events), after)
})

test('Два Варева Таши в разных ячейках не складывают повторный урон', () => {
  let state = field()
  const mage2 = state.players.find((actor) => actor.id === 'mage2')
  mage2.x = 2
  mage2.y = 2
  state.mechanics.positions.mage2 = { x: 2, y: 2 }
  const first = resolveCommand(authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'tasha-s-caustic-brew', to: { x: 6, y: 2 }, slot_level: 2, casting_resource: 'spell_slots_2' }), state, options([1, 1, 1], 'tasha-first'))
  state = replayEvents(state, first.events)
  state = { ...state, mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, active_index: 1 } } }
  const second = resolveCommand(authoritative({ command_type: 'CastSpell', actor_id: 'mage2', spell_id: 'tasha-s-caustic-brew', to: { x: 6, y: 2 }, slot_level: 3, casting_resource: 'spell_slots_3' }), state, options([1, 1, 1], 'tasha-second'))
  state = replayEvents(state, second.events)
  assert.equal((state.mechanics.conditions.foe ?? []).filter((condition) => condition.id === 'acid-covered').length, 1)
  assert.deepEqual((state.mechanics.conditions.foe ?? []).filter((condition) => condition.id === 'acid-covered').map((condition) => condition.recurring_damage), ['2d4'])
  assert.equal((state.mechanics.conditions.foe ?? []).filter((condition) => condition.recurring_damage).length, 1)
  // Tasha remains on the legacy marker path. The candidate adds effect identity
  // only to Vitriolic's instantaneous delayed rider, so two Tasha casts still
  // collapse to one existing condition rather than silently stacking.
})

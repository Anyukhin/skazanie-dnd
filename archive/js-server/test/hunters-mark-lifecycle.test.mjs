import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice() {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng([]),
    idFactory: () => `hunter-mark-roll-${++id}`,
    now: () => '2026-09-22T12:00:00.000Z',
  })
}

function stateForTwoRangers() {
  const cells = Array.from({ length: 40 }, (_, index) => ({
    x: index % 8,
    y: Math.floor(index / 8),
    type: 'floor',
    revealed: true,
  }))
  const ranger = (id, x) => ({
    id,
    character: id,
    characterClass: 'ranger',
    level: 5,
    hp: 30,
    maxHp: 30,
    armor: 15,
    speed: 30,
    proficiency: 3,
    abilities: { str: 10, dex: 18, con: 14, int: 10, wis: 14, cha: 10 },
    inventory: [],
    x,
    y: 1,
  })
  return normalizeCampaignState({
    sessionCode: 'HUNTERS-MARK-LIFECYCLE',
    partyMemberIds: ['ranger-a', 'ranger-b'],
    players: [ranger('ranger-a', 1), ranger('ranger-b', 2)],
    enemies: [{
      id: 'target',
      name: 'Цель',
      hp: 30,
      maxHp: 30,
      armor: 12,
      speed: 30,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      x: 3,
      y: 1,
      alive: true,
    }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [
          { actor_id: 'ranger-a', total: 20 },
          { actor_id: 'ranger-b', total: 18 },
          { actor_id: 'target', total: 10 },
        ],
        action_economy: {
          'ranger-a': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          'ranger-b': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const apply = (state, events) => replayEvents(state, events)

test('метки разных кастеров имеют effect_id и снимаются только вместе со своей концентрацией', () => {
  const initial = stateForTwoRangers()
  const first = resolveCommand(authoritative({
    command_type: 'UseCombatAction',
    actor_id: 'ranger-a',
    action_id: 'hunters-mark',
    target_id: 'target',
    command_id: 'mark-a',
  }), initial, { diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  const afterFirst = apply(initial, first.events)
  afterFirst.mechanics.combat.active_index = 1

  const second = resolveCommand(authoritative({
    command_type: 'UseCombatAction',
    actor_id: 'ranger-b',
    action_id: 'hunters-mark',
    target_id: 'target',
    command_id: 'mark-b',
  }), afterFirst, { diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  const marked = apply(afterFirst, second.events)
  assert.equal(marked.mechanics.conditions.target.find((condition) => condition.id === 'hunters-mark:ranger-a')?.effect_id, 'hunters-mark:mark-a')
  assert.equal(marked.mechanics.conditions.target.find((condition) => condition.id === 'hunters-mark:ranger-b')?.effect_id, 'hunters-mark:mark-b')

  const endFirst = resolveCommand(authoritative({
    command_type: 'EndConcentration',
    actor_id: 'ranger-a',
    command_id: 'end-mark-a',
    reason: 'voluntary',
  }), marked, { diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  const afterEnd = apply(marked, endFirst.events)
  assert.equal(afterEnd.mechanics.conditions.target.some((condition) => condition.id === 'hunters-mark:ranger-a'), false)
  assert.equal(afterEnd.mechanics.conditions.target.some((condition) => condition.id === 'hunters-mark:ranger-b'), true)
})

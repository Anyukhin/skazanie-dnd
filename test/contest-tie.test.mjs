import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

function dice(values) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `contest-tie-${++id}`,
    now: () => '2026-09-22T12:00:00.000Z',
  })
}

function state() {
  const cells = Array.from({ length: 12 }, (_, index) => ({
    x: index % 6,
    y: Math.floor(index / 6),
    type: 'floor',
    revealed: true,
  }))
  return normalizeCampaignState({
    sessionCode: 'CONTEST-TIE', ruleset_id: 'dnd_5e_2014',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Герой', characterClass: 'fighter', level: 1,
      hp: 12, maxHp: 12, armor: 12, speed: 30,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      inventory: [], x: 1, y: 1,
    }],
    enemies: [{
      id: 'target', name: 'Цель', hp: 12, maxHp: 12, armor: 12, speed: 30,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      x: 2, y: 1, alive: true,
    }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true,
        round: 1,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'target', total: 1 }],
        active_index: 0,
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

function useAction(actionId, values) {
  const initial = state()
  const result = resolveCommand({
    command_type: 'UseCombatAction',
    actor_id: 'hero',
    action_id: actionId,
    target_id: 'target',
    server_authoritative: true,
  }, initial, { diceService: dice(values), context: { serverAuthoritativeCombat: true } })
  return { result, after: result.events.reduce((current, event) => applyGameEvent(current, event), initial) }
}

test('равенство в захвате и толчке оставляет цель без состояния', () => {
  for (const actionId of ['grapple', 'shove']) {
    const { result, after } = useAction(actionId, [8, 10])
    const contested = result.events.find((event) => event.event_type === 'ContestedCheckResolved')
    assert.equal(contested?.payload?.attacker?.total, contested?.payload?.defender?.total)
    assert.equal(contested?.payload?.success, false, actionId)
    assert.equal((after.mechanics.conditions.target ?? []).some((condition) => ['grappled', 'prone'].includes(condition.id)), false, actionId)
  }
})

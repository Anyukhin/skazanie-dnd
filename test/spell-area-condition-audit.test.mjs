import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

test('area saving throw consumes Silvery Fortune exactly once', () => {
  const cells = Array.from({ length: 25 }, (_, index) => ({
    x: index % 5,
    y: Math.floor(index / 5),
    type: 'floor',
    revealed: true,
  }))
  const state = normalizeCampaignState({
    sessionCode: 'AREA-CONDITION-AUDIT',
    partyMemberIds: ['caster', 'target'],
    players: [
      {
        id: 'caster', character: 'Маг', characterClass: 'wizard', level: 5,
        hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 3,
        abilities: { int: 18, con: 14 }, inventory: [], x: 0, y: 0,
      },
      {
        id: 'target', character: 'Цель', characterClass: 'fighter', level: 5,
        hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 3,
        abilities: { dex: 10, con: 10 }, inventory: [], x: 2, y: 2,
      },
    ],
    enemies: [],
    scene: { turn: 1, cells },
    mechanics: {
      conditions: {
        target: [
          { id: 'silvery-fortune', source_actor: 'caster', duration: 'rounds:10', effect_id: 'fortune-a' },
          { id: 'silvery-fortune', source_actor: 'caster', duration: 'rounds:10', effect_id: 'fortune-b' },
        ],
      },
      active_effects: [{
        id: 'stinking-cloud:condition-audit',
        effect_id: 'stinking-cloud:condition-audit',
        spell_id: 'stinking-cloud',
        source_actor: 'caster',
        center: { x: 2, y: 2 },
        radius_feet: 20,
        area_shape: 'sphere',
        trigger_on_turn_start: true,
        save_ability: 'con',
        save_dc: 15,
        save_damage_type: 'poison',
        requires_breathing: true,
        spend_action_on_fail: true,
      }],
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'target', total: 10 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
  let rollId = 0
  const result = resolveCommand({ command_type: 'EndTurn', command_id: 'area-condition', actor_id: 'caster', server_authoritative: true }, state, {
    diceService: new DiceService({
      rng: new SequenceDiceRng(Array(50).fill(1)),
      idFactory: () => `area-condition-${++rollId}`,
      now: () => '2026-09-19T12:00:00.000Z',
    }),
    context: { serverAuthoritativeCombat: true },
  })
  assert.ok(result.events.some((event) => event.event_type === 'ConditionRemoved'
    && event.payload.condition === 'silvery-fortune'
    && event.payload.effect_id === 'fortune-a'
    && event.target_ids.includes('target')))
  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.conditions.target.some((condition) => condition.id === 'silvery-fortune' && condition.effect_id === 'fortune-a'), false)
  assert.equal(after.mechanics.conditions.target.some((condition) => condition.id === 'silvery-fortune' && condition.effect_id === 'fortune-b'), true)
})

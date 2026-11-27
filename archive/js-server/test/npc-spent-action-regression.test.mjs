import assert from 'node:assert/strict'
import test from 'node:test'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { normalizeCampaignState, resolveCommands } from '../server/rules-engine.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'

test('NPC с одной атакой завершает ход после Отхода и перемещения', () => {
  const state = normalizeCampaignState({
    sessionCode: 'SPENT-NPC', partyMemberIds: ['hero'],
    players: [{ id: 'hero', hp: 30, maxHp: 30, armor: 16, x: 6, y: 2, abilities: {} }],
    enemies: [{ id: 'goblin', hp: 1, maxHp: 7, armor: 15, speed: 30, x: 1, y: 3, alive: true,
      action_profiles: [{ id: 'shortbow', name: 'Короткий лук', kind: 'ranged', attack_modifier: 4,
        damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 320, normal_range_feet: 80 }] }],
    scene: { turn: 1, cells: Array.from({ length: 50 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), type: 'floor', revealed: true })) },
    mechanics: { combat: { active: true, round: 3, active_index: 0,
      initiative: [{ actor_id: 'goblin', total: 15 }, { actor_id: 'hero', total: 10 }],
      action_economy: { goblin: { action: false, bonus_action: true, reaction: true, movement_spent: 30, attacks_used: 0, attacks_allowed: 1 } } } },
  })
  const commands = planNpcTurn(state, 'goblin')
  assert.deepEqual(commands, [{ command_type: 'EndTurn', actor_id: 'goblin' }], 'Отход уже потратил действие: стрелять после него нельзя')
  const result = resolveCommands(commands, state, {
    diceService: new DiceService({ rng: new SequenceDiceRng([]) }),
    context: { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true },
  })
  assert.ok(result.events.some((event) => event.event_type === 'TurnEnded'))
  assert.ok(!result.events.some((event) => event.event_type === 'AttackResolved'))
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { planHeroCombatCommand } from '../server/party-tactics.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'

const floor = Array.from({ length: 64 }, (_, index) => ({
  x: index % 8,
  y: Math.floor(index / 8),
  type: 'floor',
  revealed: true,
}))

function dice() {
  return new DiceService({ rng: new SequenceDiceRng([]), idFactory: (() => { let index = 0; return () => `resistance-planner-roll-${++index}` })(), now: () => '2026-09-19T12:00:00.000Z' })
}

test('2014 state reaches party planner with Resistance without a legacy damage option', () => {
  const state = normalizeCampaignState({
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    sessionCode: 'RESISTANCE-PLANNER',
    partyMemberIds: ['hero', 'ally'],
    scene: { title: 'Арена', location: 'arena', cells: floor },
    players: [
      {
        id: 'hero', character: 'Жрец', characterClass: 'cleric', level: 1,
        hp: 20, maxHp: 20, armor: 14, speed: 30, proficiency: 2,
        abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 16, cha: 12 },
        knownSpellIds: ['resistance'], preparedSpellIds: ['resistance'],
        inventory: [materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'hero-component-pouch', quantity: 1 })], x: 1, y: 1,
      },
      {
        id: 'ally', character: 'Союзник', characterClass: 'fighter', level: 1,
        hp: 20, maxHp: 20, armor: 14, speed: 30, proficiency: 2,
        abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
        inventory: [], x: 2, y: 1,
      },
    ],
    enemies: [],
    mechanics: {
      positions: { hero: { x: 1, y: 1 }, ally: { x: 2, y: 1 } },
      combat: {
        active: true,
        round: 1,
        initiative: [{ actor_id: 'hero', total: 18 }, { actor_id: 'ally', total: 12 }],
        active_index: 0,
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          ally: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })

  const plan = planHeroCombatCommand(state, 'hero')
  assert.equal(plan.command.command_type, 'CastSpell')
  assert.equal(plan.command.spell_id, 'resistance')
  assert.equal(Object.hasOwn(plan.command, 'spell_option'), false)

  const result = resolveCommand(plan.command, state, {
    diceService: dice(),
    context: { serverAuthoritativeCombat: true, allowedActorIds: ['hero'] },
  })
  const after = result.events.reduce((current, event) => applyGameEvent(current, event), state)
  assert.ok(after.mechanics.conditions.hero?.some((condition) => condition.id === 'resistance-d4'))
  assert.equal(after.mechanics.conditions.hero?.some((condition) => condition.id === 'resistance-damage:fire'), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { normalizeCampaignState, spellTargetsAt } from '../server/rules-engine.mjs'

function state() {
  const cells = Array.from({ length: 40 }, (_, index) => ({
    x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true,
  }))
  return normalizeCampaignState({
    sessionCode: 'MASS-CURE-DYING-TARGET',
    partyMemberIds: ['caster', 'dying', 'dead'],
    players: [
      { id: 'caster', character: 'Жрец', characterClass: 'cleric', hp: 30, maxHp: 30, armor: 14, speed: 30, proficiency: 4, abilities: { wis: 18, dex: 12, con: 14 }, x: 1, y: 2 },
      { id: 'dying', character: 'Павший', characterClass: 'fighter', hp: 0, maxHp: 20, armor: 12, speed: 30, proficiency: 3, abilities: { wis: 10, dex: 10, con: 10 }, x: 4, y: 2 },
      { id: 'dead', character: 'Мёртвый', characterClass: 'fighter', hp: 0, maxHp: 20, armor: 12, speed: 30, proficiency: 3, abilities: { wis: 10, dex: 10, con: 10 }, x: 5, y: 2 },
    ],
    enemies: [],
    scene: { turn: 1, cells },
    mechanics: {
      death: { heroes: { dead: { status: 'dead' } } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'dying', total: 10 }, { actor_id: 'dead', total: 5 }],
        action_economy: Object.fromEntries(['caster', 'dying', 'dead'].map((id) => [id, {
          action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0,
        }])),
      },
    },
  })
}

test('Mass Cure Wounds area includes a dying hero and excludes a truly dead hero', () => {
  const spell = canonicalCombatSpellFor('mass-cure-wounds')
  const current = state()
  const pointAreaProfile = { ...spell, target: 'point', mechanicsSupport: 'partial' }
  const targets = spellTargetsAt(current, { actor_id: 'caster', to: { x: 4, y: 2 } }, pointAreaProfile)

  assert.equal(spell.kind, 'healing')
  assert.equal(spell.areaShape, 'sphere')
  assert.ok(targets.some((actor) => actor.id === 'dying'))
  assert.equal(targets.some((actor) => actor.id === 'dead'), false)
})

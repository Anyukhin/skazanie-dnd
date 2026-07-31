import assert from 'node:assert/strict'
import test from 'node:test'

import { serverEncounterLoot, serverRewardForEncounter } from '../server/autonomous-campaign.mjs'

function victoryState() {
  const enemies = [
    {
      id: 'rat-1',
      hp: 0,
      alive: false,
      stat_block_id: 'srd_5_2_1:giant-rat',
      xp: Number.MAX_SAFE_INTEGER,
      provenance: { xp: 25 },
    },
    {
      id: 'goblin-1',
      hp: 0,
      alive: false,
      stat_block_id: 'srd_5_2_1:goblin-warrior',
      xp: -999,
      provenance: { xp: 50 },
    },
  ]
  return {
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', hp: 10, maxHp: 10, inventory: [], currency: {} }],
    mechanics: {
      death: { heroes: {} },
      encounter: {
        id: 'encounter-1',
        encounter_id: 'encounter-1',
        status: 'ended',
        outcome: 'enemies_defeated',
        difficulty: 'medium',
        theme: 'generic',
        xp_spent: Number.MAX_SAFE_INTEGER,
        enemy_ids: enemies.map((enemy) => enemy.id),
        enemies: enemies.map((enemy) => ({ id: enemy.id, stat_block_id: enemy.stat_block_id })),
      },
    },
    enemies,
  }
}

test('compat reward API использует strict frozen server-owned plan', () => {
  const reward = serverRewardForEncounter(victoryState(), 'enemies_defeated')
  assert.equal(reward.xp, 75)
  assert.deepEqual(reward.recipients, ['hero'])
  assert.equal(reward.progression, 'xp')
  assert.equal(reward.milestone, null)
  assert.deepEqual(reward.loot, serverEncounterLoot({ theme: 'generic', difficulty: 'medium', encounterId: 'encounter-1' }))
  assert.equal(reward.loot.length, 2)
  assert.equal(reward.loot.some((item) => /potion|ring-of|wand-of|longsword-plus/u.test(item.catalog_id)), false)
})

test('поражение не выдаёт XP, milestone, coins contract или добычу', () => {
  const reward = serverRewardForEncounter({
    partyMemberIds: ['dead'],
    players: [{ id: 'dead', hp: 0, maxHp: 10, inventory: [], currency: {} }],
    mechanics: {
      death: { heroes: { dead: { status: 'dead' } } },
      encounter: {
        id: 'encounter-2',
        encounter_id: 'encounter-2',
        status: 'ended',
        outcome: 'party_defeated',
        difficulty: 'hard',
        theme: 'warband',
      },
    },
    enemies: [{ id: 'ogre', hp: 0, alive: false, stat_block_id: 'srd_5_2_1:ogre', provenance: { xp: 450 } }],
  }, 'party_defeated')

  assert.equal(reward.xp, 0)
  assert.equal(reward.progression, null)
  assert.equal(reward.milestone, null)
  assert.deepEqual(reward.loot, [])
})

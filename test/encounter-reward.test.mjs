import assert from 'node:assert/strict'
import test from 'node:test'

import { serverRewardForEncounter } from '../server/autonomous-campaign.mjs'

test('награда берёт XP только из server-owned проекции EncounterAssembler и не удваивает его', () => {
  const reward = serverRewardForEncounter({
    mechanics: { encounter: { id: 'encounter-1', difficulty: 'medium', xp_spent: 100 } },
    enemies: [
      { id: 'wolf-1', provenance: { kind: 'server-owned-srd-primary-attack-projection', xp: 50 } },
      { id: 'wolf-2', provenance: { kind: 'server-owned-srd-primary-attack-projection', xp: 50 } },
    ],
  }, 'enemies_defeated')

  assert.equal(reward.xp, 100)
  assert.equal(reward.progression, 'xp')
  assert.equal(reward.milestone, null)
  assert.deepEqual(reward.loot, [{ catalog_id: 'srd_5_2_1:healing-potion', name: 'Зелье лечения', quantity: 1 }])
})

test('поражение не выдаёт XP или добычу независимо от данных встречи', () => {
  const reward = serverRewardForEncounter({
    mechanics: { encounter: { id: 'encounter-2', difficulty: 'hard', xp_spent: 200 } },
    enemies: [{ provenance: { xp: 200 } }],
  }, 'party_defeated')

  assert.equal(reward.xp, 0)
  assert.deepEqual(reward.loot, [])
})

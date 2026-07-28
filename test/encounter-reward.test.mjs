import assert from 'node:assert/strict'
import test from 'node:test'

import { serverEncounterLoot, serverRewardForEncounter } from '../server/autonomous-campaign.mjs'

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
  // Встреча без темы собирает добычу по таблице `generic`; зелье за среднюю
  // сложность осталось, к нему добавился тематический предмет.
  assert.deepEqual(reward.loot, serverEncounterLoot({ theme: '', difficulty: 'medium', encounterId: 'encounter-1' }))
  assert.equal(reward.loot.filter((item) => item.catalog_id === 'srd_5_2_1:potion-of-healing').length, 1)
})

test('поражение не выдаёт XP или добычу независимо от данных встречи', () => {
  const reward = serverRewardForEncounter({
    mechanics: { encounter: { id: 'encounter-2', difficulty: 'hard', xp_spent: 200 } },
    enemies: [{ provenance: { xp: 200 } }],
  }, 'party_defeated')

  assert.equal(reward.xp, 0)
  assert.deepEqual(reward.loot, [])
})

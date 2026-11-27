import assert from 'node:assert/strict'
import test from 'node:test'

import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

function stateFixture() {
  return normalizeCampaignState({
    sessionCode: 'XP-AWARD',
    partyMemberIds: ['hero-1', 'hero-2', 'hero-3', 'hero-4'],
    players: [
      { id: 'hero-1', experience: 10, hp: 10, maxHp: 10, inventory: [] },
      { id: 'hero-2', experience: 0, hp: 10, maxHp: 10, inventory: [] },
      { id: 'hero-3', experience: 0, hp: 10, maxHp: 10, inventory: [] },
      { id: 'hero-4', experience: 0, hp: 10, maxHp: 10, inventory: [] },
    ],
  })
}

test('ExperienceAwarded projects an equal deterministic party share onto visible hero XP', () => {
  const awarded = applyGameEvent(stateFixture(), {
    event_type: 'ExperienceAwarded',
    target_ids: ['hero-1', 'hero-2', 'hero-3', 'hero-4'],
    payload: { total_xp: 300, recipients: ['hero-1', 'hero-2', 'hero-3', 'hero-4'] },
    state_version_after: 1,
  })

  assert.deepEqual(awarded.players.map((hero) => hero.experience), [85, 75, 75, 75])
  assert.equal(awarded.players.reduce((sum, hero) => sum + hero.experience, 0), 310)
  assert.equal(awarded.state_version, 1)
  assert.equal(awarded.players.length, 4)
})

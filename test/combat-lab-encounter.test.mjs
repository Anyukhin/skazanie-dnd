import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMBAT_LAB_ENCOUNTER_THEMES,
  assessCombatLabEncounter,
  buildCombatLabState,
  generateCombatLabEncounter,
} from '../server/combat-lab-setup.mjs'
import {
  COMBAT_LAB_RULES_SOURCE_2014,
  encounterMultiplier,
  partyThresholds2014,
} from '../server/combat-lab-encounter-math.mjs'

const trainingParty = [
  { source: 'class', classId: 'fighter', level: 3, x: 0, y: 0 },
  { source: 'class', classId: 'wizard', level: 2, x: 1, y: 0 },
]

test('2014 thresholds and party-size multiplier follow the published rules', () => {
  assert.deepEqual(partyThresholds2014([3, 3, 3, 2]), { easy: 275, medium: 550, hard: 825, deadly: 1_400 })
  assert.equal(encounterMultiplier(1, 2), 1.5)
  assert.equal(encounterMultiplier(2, 2), 2)
  assert.equal(encounterMultiplier(4, 4), 2)
  assert.equal(encounterMultiplier(1, 6), 0.5)
  assert.equal(encounterMultiplier(4, 6), 1.5)
  assert.equal(encounterMultiplier(15, 1), 5)
  assert.equal(COMBAT_LAB_RULES_SOURCE_2014.edition, '2014')
})

test('assessment counts actual stat-block XP and does not fabricate an empty fight', async () => {
  const empty = await assessCombatLabEncounter({
    config: { mapId: 'open-courtyard', party: trainingParty, enemies: [] },
    difficulty: 'medium',
    seed: 17,
  })
  assert.equal(empty.rawXp, 0)
  assert.equal(empty.adjustedXp, 0)
  assert.equal(empty.difficulty, 'trivial')
  assert.equal(empty.matched, false)
  assert.ok(empty.warnings.length > 0)

  const explicit = await assessCombatLabEncounter({
    config: {
      mapId: 'open-courtyard',
      party: [{ source: 'class', classId: 'fighter', level: 1 }],
      enemies: [{ monsterId: 'dnd_5e_2014:monster:goblin' }],
    },
    difficulty: 'hard',
    seed: 17,
  })
  assert.equal(explicit.rawXp, 50)
  assert.equal(explicit.adjustedXp, 75)
  assert.equal(explicit.multiplier, 1.5)
  assert.equal(explicit.difficulty, 'hard')
  assert.equal(explicit.matched, true)
  assert.deepEqual(explicit.monsterBreakdown, [{ id: 'dnd_5e_2014:monster:goblin', name: 'Гоблин', cr: '1/4', xp: 50, count: 1 }])
})

test('assessment canonicalizes a campaign hero level and reports the correction', async () => {
  const assessment = await assessCombatLabEncounter({
    config: {
      mapId: 'open-courtyard',
      party: [{ source: 'hero', campaignId: 'SOURCE-2014', heroId: 'hero', level: 1 }],
      enemies: [{ monsterId: 'dnd_5e_2014:monster:goblin' }],
    },
    difficulty: 'medium',
    seed: 'campaign-level',
  }, {
    loadCampaign: async () => ({
      ruleset_id: 'dnd_5e_2014',
      players: [{ id: 'hero', name: 'Боевой герой', level: 3 }],
    }),
  })
  assert.deepEqual(assessment.partyLevels, [3])
  assert.ok(assessment.warnings.some((warning) => warning.includes('взят из кампании: 3')))
})

test('generated encounter is seeded, bounded, themed, reachable and executable by setup', async () => {
  const request = { config: { mapId: 'ruined-hall', party: trainingParty }, difficulty: 'hard', seed: 'same-seed', theme: 'goblinoids' }
  const first = await generateCombatLabEncounter(request)
  const second = await generateCombatLabEncounter(request)
  assert.deepEqual(second, first)
  assert.ok(first.config.enemies.length >= 1 && first.config.enemies.length <= 4)
  assert.equal(first.assessment.requestedDifficulty, 'hard')
  assert.equal(first.assessment.matched, true)
  assert.ok(first.config.enemies.every((enemy) => enemy.monsterId.startsWith('dnd_5e_2014:monster:')))
  assert.ok(first.assessment.monsterBreakdown.every((monster) => ['goblinoids'].includes(first.assessment.theme)))
  const state = await buildCombatLabState(first.config)
  assert.equal(state.players.length, trainingParty.length)
  assert.equal(state.enemies.length, first.config.enemies.length)
  assert.ok(state.enemies.every((enemy) => enemy.stat_block_id.startsWith('dnd_5e_2014:monster:')))
})

test('generated encounter accepts empty placements and rejects unsupported difficulty or theme', async () => {
  const result = await generateCombatLabEncounter({
    mapId: 'open-courtyard',
    party: [{ source: 'class', classId: 'fighter', level: 1 }],
    difficulty: 'easy',
    seed: 0,
    theme: 'undead',
  })
  assert.ok(result.config.party[0].x >= 0)
  assert.ok(result.config.enemies.length <= 2)
  await assert.rejects(
    () => generateCombatLabEncounter({ mapId: 'open-courtyard', party: trainingParty, difficulty: 'trivial', seed: 1 }),
    (error) => error.code === 'INVALID_COMBAT_LAB_DIFFICULTY',
  )
  await assert.rejects(
    () => generateCombatLabEncounter({ mapId: 'open-courtyard', party: trainingParty, difficulty: 'easy', seed: 1, theme: 'unknown' }),
    (error) => error.code === 'UNKNOWN_COMBAT_LAB_THEME',
  )
  assert.ok(COMBAT_LAB_ENCOUNTER_THEMES.includes('dragons'))
})

test('assessment rejects duplicate campaign heroes before generation', async () => {
  const duplicate = {
    mapId: 'open-courtyard',
    party: [
      { source: 'hero', campaignId: 'SOURCE-2014', heroId: 'hero' },
      { source: 'hero', campaignId: 'SOURCE-2014', heroId: 'hero' },
    ],
    enemies: [],
  }
  await assert.rejects(
    () => assessCombatLabEncounter({ config: duplicate }, {
      loadCampaign: async () => ({ ruleset_id: 'dnd_5e_2014', players: [{ id: 'hero', level: 3 }] }),
    }),
    (error) => error.code === 'DUPLICATE_HERO_SOURCE',
  )
})

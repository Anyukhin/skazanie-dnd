import assert from 'node:assert/strict'
import test from 'node:test'

import { MILESTONES_PER_LEVEL, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

function campaign() {
  return normalizeCampaignState({
    sessionCode: 'MILESTONES',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    scene: { title: 'Дорога', location: 'Дорога', cells: [] },
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, level: 1, inventory: [] }],
  })
}

const milestone = (index, overrides = {}) => ({
  event_id: `milestone-${index}`,
  event_type: 'MilestoneAwarded',
  actor_id: 'hero',
  target_ids: [],
  payload: { milestone: 'encounter-resolved', encounter_id: `encounter-${index}` },
  visibility: 'party',
  source_rule_ids: [],
  ...overrides,
})

test('свежая кампания начинается без вех и без права на уровень', () => {
  const progression = campaign().mechanics.progression
  assert.deepEqual(progression.milestones, [])
  assert.equal(progression.milestones_since_level, 0)
  assert.equal(progression.level_up_available, false)
  assert.equal(progression.milestones_per_level, MILESTONES_PER_LEVEL)
})

test('вехи копятся и после порога объявляют заслуженный уровень', () => {
  let state = campaign()
  for (let index = 1; index < MILESTONES_PER_LEVEL; index += 1) {
    state = applyGameEvent(state, milestone(index))
    assert.equal(state.mechanics.progression.level_up_available, false, `после ${index} вех уровень ещё не заслужен`)
  }
  state = applyGameEvent(state, milestone(MILESTONES_PER_LEVEL))

  assert.equal(state.mechanics.progression.milestones_since_level, MILESTONES_PER_LEVEL)
  assert.equal(state.mechanics.progression.level_up_available, true)
  assert.equal(state.mechanics.progression.milestones.length, MILESTONES_PER_LEVEL)
})

test('уровень не выдаётся сам: политика лишь объявляет его заслуженным', () => {
  let state = campaign()
  for (let index = 1; index <= MILESTONES_PER_LEVEL; index += 1) state = applyGameEvent(state, milestone(index))
  // Сервер не решает за игрока подкласс и умения, поэтому уровень остаётся прежним.
  assert.equal(state.players[0].level, 1)
})

test('повторный commit той же вехи не приближает уровень второй раз', () => {
  let state = campaign()
  state = applyGameEvent(state, milestone(1))
  state = applyGameEvent(state, milestone(1))

  assert.equal(state.mechanics.progression.milestones_since_level, 1)
  assert.equal(state.mechanics.progression.milestones.length, 1)
})

test('прогрессия переживает нормализацию — значит, и снимок с replay', () => {
  let state = campaign()
  for (let index = 1; index <= MILESTONES_PER_LEVEL; index += 1) state = applyGameEvent(state, milestone(index))
  const restored = normalizeCampaignState(JSON.parse(JSON.stringify(state)))

  assert.equal(restored.mechanics.progression.milestones_since_level, MILESTONES_PER_LEVEL)
  assert.equal(restored.mechanics.progression.level_up_available, true)
  assert.deepEqual(restored.mechanics.progression.milestones, state.mechanics.progression.milestones)
})

test('старая кампания без реестра прогрессии нормализуется без падения', () => {
  const legacy = normalizeCampaignState({
    sessionCode: 'LEGACY',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, inventory: [] }],
    scene: { title: 'S', location: 'L', cells: [] },
    mechanics: { positions: {} },
  })
  assert.equal(legacy.mechanics.progression.milestones_since_level, 0)
  assert.equal(legacy.mechanics.progression.level_up_available, false)
})

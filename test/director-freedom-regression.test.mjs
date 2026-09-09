import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeDirectorIntent } from '../server/autonomous-campaign.mjs'
import { sceneResolutionProof, transitionDecisionMatches } from '../server/autonomous-orchestrator.mjs'
import {
  authorizeDirectorIntent,
  affirmativePlayerAction,
  buildCampaignArcPlan,
  campaignArcClimaxSatisfied,
  confirmedQuestProgress,
} from '../server/campaign-loop-policy.mjs'

function finalState() {
  const arc = buildCampaignArcPlan('freedom-regression')
  return {
    campaignConcept: { arc },
    adventure: { chapter: arc.target_scenes },
    mechanics: { combat: { active: false } },
    worldMemory: {
      quests: [{ id: `quest:chapter:${arc.target_scenes}`, status: 'completed', clock: { triggered: true } }],
    },
    autonomy: { director_history: [], director_outcomes: [], scene_resolutions: [] },
  }
}

test('Director intent supports bounded non-combat scene resolution', () => {
  assert.deepEqual(normalizeDirectorIntent({ type: 'resolve_scene', resolution: 'negotiation' }), {
    version: 'skazanie:director-intent-v1', type: 'resolve_scene', resolution: 'negotiation',
  })
  assert.throws(() => normalizeDirectorIntent({ type: 'resolve_scene', resolution: 'success' }), /allowlist/u)
})

test('final arc does not force quest clock or a hard encounter', () => {
  const state = finalState()
  const result = authorizeDirectorIntent(state, { type: 'offer_next_hook', hook: 'Игроки выбирают переговоры' })
  assert.equal(result.replaced, false)
  assert.equal(result.intent.type, 'offer_next_hook')
  assert.notEqual(result.intent.type, 'request_encounter')
  assert.notEqual(result.intent.type, 'advance_quest_clock')
  assert.equal(campaignArcClimaxSatisfied(state), false)
})

test('confirmed typed scene resolution satisfies the arc without combat', () => {
  const state = finalState()
  const arc = state.campaignConcept.arc
  state.autonomy.scene_resolutions = [{ chapter: arc.target_scenes, resolution: 'negotiation', status: 'confirmed' }]
  assert.equal(campaignArcClimaxSatisfied(state), true)
})

test('scene resolution proof requires existing facts and never trusts resolution text', () => {
  const intent = normalizeDirectorIntent({ type: 'resolve_scene', resolution: 'negotiation' })
  assert.equal(sceneResolutionProof({ social: { conversations: [] } }, intent), null)
  const stale = {
    scene: { location: 'Трактир' },
    partyMemberIds: ['hero'],
    social: {
      npcs: [{ id: 'npc-1', location: 'Старая дорога', available: true }],
      conversations: [{ id: 'conversation-old', npc_id: 'npc-1', hero_id: 'hero', check: { success: true } }],
    },
  }
  assert.equal(sceneResolutionProof(stale, intent), null)
  const proof = sceneResolutionProof({
    scene: { location: 'Старая дорога' },
    adventure: { chapter: 1 },
    partyMemberIds: ['hero'],
    worldMemory: {
      quests: [{ id: 'quest:chapter:1', entity_ids: ['road'], objectives: ['Найти след каравана'] }],
      facts: [{ id: 'fact-caravan', subject_id: 'road', summary: 'След каравана указывает на тайну' }],
    },
    social: {
      npcs: [{ id: 'npc-1', location: 'Старая дорога', available: true }],
      conversations: [{ id: 'conversation-1', npc_id: 'npc-1', hero_id: 'hero', disclosed_fact_ids: ['fact-caravan'], check: { success: true } }],
    },
  }, intent)
  assert.deepEqual(proof, { evidence_type: 'successful_npc_check', evidence_id: 'conversation-1' })
})

test('transition vote is bound to this destination, key and continue option', () => {
  const interaction = {
    id: 'decision-a', destinationLocationId: 'Северные ворота', status: 'resolved', resolvedOptionId: 'continue',
    options: [{ id: 'continue' }, { id: 'stay' }],
  }
  assert.equal(transitionDecisionMatches(interaction, { decisionId: 'decision-a', destination: 'Северные ворота' }), true)
  assert.equal(transitionDecisionMatches(interaction, { decisionId: 'decision-b', destination: 'Северные ворота' }), false)
  assert.equal(transitionDecisionMatches(interaction, { decisionId: 'decision-a', destination: 'Южные ворота' }), false)
  assert.equal(transitionDecisionMatches({ ...interaction, resolvedOptionId: 'stay' }, { decisionId: 'decision-a', destination: 'Северные ворота' }), false)
})

test('quest clock requires new confirmed progress and cannot reuse one outcome', () => {
  const state = {
    worldMemory: {
      facts: [{ id: 'fact-1', predicate: 'discovery', subject_id: 'entity-1', source_event_ids: ['event-1'] }],
      quests: [{ id: 'quest-1', status: 'active', entity_ids: ['entity-1'], clock: { triggered: false } }],
    },
    autonomy: {
      director_history: [{ intent: { type: 'continue_exploration' } }],
      director_outcomes: [{ state_changed: true, progress_before: 'a', progress_after: 'b' }],
    },
  }
  assert.equal(confirmedQuestProgress(state, 'quest-1'), true)
  state.autonomy.director_history.push({ intent: { type: 'advance_quest_clock', quest_id: 'quest-1' } })
  state.worldMemory.quests[0].clock.current = 1
  assert.equal(confirmedQuestProgress(state, 'quest-1'), false)
})

test('explicit combat and transition opt-ins reject negation and forged model reasons', () => {
  assert.equal(affirmativePlayerAction('Ищем бой с угрозой', 'encounter'), true)
  assert.equal(affirmativePlayerAction('Не хочу бой, идём тихо', 'encounter'), false)
  for (const phrase of ['Мы не атакуем', 'Если согласится, атакуем', 'Говорю «ищем бой»', 'Обсудим, как перейти дальше']) {
    assert.equal(affirmativePlayerAction(phrase, 'encounter'), false, phrase)
    assert.equal(affirmativePlayerAction(phrase, 'transition'), false, phrase)
  }
  const state = { mechanics: { combat: { active: false } }, autonomy: {}, worldMemory: { quests: [] }, adventure: { chapter: 1 } }
  const forged = authorizeDirectorIntent(state, { type: 'request_encounter', theme: 'beasts', difficulty: 'medium', reason: 'Игрок явно запросил столкновение.' })
  assert.notEqual(forged.intent.type, 'request_encounter')
  const explicit = authorizeDirectorIntent(state, { type: 'request_encounter', theme: 'beasts', difficulty: 'medium' }, { playerAction: 'Ищем бой с угрозой' })
  assert.equal(explicit.intent.type, 'request_encounter')
})

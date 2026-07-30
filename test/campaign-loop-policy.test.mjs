import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authorizeDirectorIntent,
  assembleSocialNpc,
  buildCampaignArcPlan,
  campaignArcClimaxSatisfied,
  campaignArcPosition,
  completedDowntime,
  pacingForDirectorIntent,
  planServerTravel,
} from '../server/campaign-loop-policy.mjs'

const baseState = {
  sessionCode: 'LOOP-1',
  partyMemberIds: ['hero-a', 'hero-b'],
  players: [{ id: 'hero-a' }, { id: 'hero-b' }],
  scene: { location: 'Северный тракт', scene_kind: 'wilderness' },
  adventure: { chapter: 2 },
  mechanics: { world_time: { elapsed_minutes: 120 }, death: { heroes: {} } },
  worldMemory: {
    entities: [{ id: 'wardens', kind: 'faction' }],
    facts: [{ id: 'fact-1', status: 'active', visibility: 'party' }],
    quests: [{ id: 'quest-1', status: 'active', clock: { current: 5, max: 6 } }],
  },
  autonomy: { pacing: { beat: 4, phase: 'escalation', tension: 82 } },
}

test('server pacing derives bounded tension from a narrative-only intent', () => {
  const pacing = pacingForDirectorIntent(baseState, { type: 'advance_quest_clock' })
  assert.deepEqual(pacing, {
    beat: 5,
    phase: 'climax',
    tension_before: 82,
    tension_after: 96,
    delta: 14,
    intent_type: 'advance_quest_clock',
    policy: 'campaign-pacing-v1',
  })
})

test('Rules policy replaces repeated and phase-incompatible Director intents', () => {
  const state = structuredClone(baseState)
  state.autonomy.director_history = [{ intent: { type: 'open_social_scene' } }]
  state.autonomy.director_outcomes = [{ intent_type: 'open_social_scene', state_changed: false }]
  state.autonomy.pacing = { beat: 7, phase: 'escalation', tension: 68 }

  const authorized = authorizeDirectorIntent(state, { type: 'open_social_scene' })

  assert.equal(authorized.replaced, true)
  assert.equal(authorized.reason, 'anti_stall_replacement')
  assert.equal(authorized.intent.type, 'advance_quest_clock')
  assert.equal(authorized.intent.quest_id, 'quest-1')
  assert.ok(!authorized.allowed_types.includes('open_social_scene'))
})

test('pacing grows on social and hook beats instead of rewarding stagnation', () => {
  assert.equal(pacingForDirectorIntent({ autonomy: { pacing: { tension: 10 } } }, { type: 'open_social_scene' }).tension_after, 18)
  assert.equal(pacingForDirectorIntent({ autonomy: { pacing: { tension: 18 } } }, { type: 'offer_next_hook' }).tension_after, 24)
})

test('travel policy is deterministic and owns time, risk and random encounter mechanics', () => {
  const options = { campaignId: 'LOOP-1', destination: 'Заброшенный склеп', idempotencyKey: 'travel-1' }
  const first = planServerTravel(baseState, options)
  const second = planServerTravel(baseState, options)
  assert.deepEqual(first, second)
  assert.ok(first.duration_minutes >= 75)
  assert.ok(first.risk_score >= 65)
  assert.equal(typeof first.random_encounter, 'boolean')
  if (first.random_encounter) {
    assert.ok(['undead', 'raiders'].includes(first.encounter.theme))
    assert.ok(['easy', 'medium', 'hard'].includes(first.encounter.difficulty))
  }
  const triggered = Array.from({ length: 200 }, (_, index) => planServerTravel(baseState, {
    ...options,
    idempotencyKey: `travel-risk-${index}`,
  })).find((travel) => travel.random_encounter)
  assert.ok(triggered, 'high server-owned travel risk must be able to trigger a random encounter')
  assert.ok(['undead', 'raiders'].includes(triggered.encounter.theme))
})

test('social assembler creates a replay-stable bounded NPC using only known public facts', () => {
  const options = { campaignId: 'LOOP-1', idempotencyKey: 'social-1' }
  const first = assembleSocialNpc(baseState, options)
  assert.deepEqual(first, assembleSocialNpc(baseState, options))
  assert.match(first.id, /^npc-[a-f0-9]{16}$/u)
  assert.equal(first.location, 'Северный тракт')
  assert.deepEqual(first.known_fact_ids, ['fact-1'])
  assert.deepEqual(first.tags, ['faction:wardens'])
  assert.deepEqual(first.inventory, [])
})

test('downtime excludes dead heroes and derives its own duration', () => {
  const state = structuredClone(baseState)
  state.mechanics.death.heroes['hero-b'] = { status: 'dead' }
  const downtime = completedDowntime(state)
  assert.deepEqual(downtime.participant_ids, ['hero-a'])
  assert.equal(downtime.duration_minutes, 480)
  assert.equal(downtime.policy, 'server-downtime-v1')
})

test('one-evening arc is seed-stable, bounded to 3-5 scenes and leaves legacy pacing untouched', () => {
  const first = buildCampaignArcPlan('evening-seed')
  const second = buildCampaignArcPlan('evening-seed')
  const structure = (plan) => Array.from({ length: plan.target_scenes }, (_, index) => campaignArcPosition({
    campaignConcept: { arc: plan },
    adventure: { chapter: index + 1 },
    autonomy: { director_history: [] },
    worldMemory: { quests: [] },
  }).phase)

  assert.deepEqual(first, second)
  assert.deepEqual(structure(first), structure(second))
  assert.ok(first.target_scenes >= 3 && first.target_scenes <= 5)
  assert.equal(first.chapter_clock_max, 2)
  assert.equal(pacingForDirectorIntent(baseState, { type: 'advance_quest_clock' }).policy, 'campaign-pacing-v1')
})

test('one-evening policy closes a resolved chapter and forces a hard final encounter', () => {
  const plan = buildCampaignArcPlan('forced-evening')
  const state = structuredClone(baseState)
  state.campaignConcept = { arc: plan }
  state.adventure.chapter = 1
  state.worldMemory.quests = [
    { id: 'quest:chapter:1', status: 'active', clock: { current: 0, max: 2, triggered: false } },
    { id: 'quest:main', status: 'active', clock: { current: 0, max: plan.target_scenes, triggered: false } },
  ]
  state.autonomy.director_history = [
    { intent: { type: 'continue_exploration' } },
    { intent: { type: 'open_social_scene' } },
  ]

  const clock = authorizeDirectorIntent(state, { type: 'offer_next_hook', hook: 'stall' })
  assert.equal(clock.intent.type, 'advance_quest_clock')
  assert.equal(clock.intent.quest_id, 'quest:chapter:1')
  assert.equal(clock.reason, 'one_evening_scene_clock')

  state.worldMemory.quests[0].clock.current = 1
  const openingEncounter = authorizeDirectorIntent(state, {
    type: 'request_encounter',
    theme: 'beasts',
    difficulty: 'medium',
  })
  assert.equal(openingEncounter.intent.type, 'request_encounter')
  assert.equal(openingEncounter.reason, 'one_evening_opening_encounter')

  state.worldMemory.quests[0].status = 'completed'
  state.worldMemory.quests[0].clock.triggered = true
  const transition = authorizeDirectorIntent(state, { type: 'offer_next_hook', hook: 'stall again' })
  assert.equal(transition.intent.type, 'end_scene')
  assert.equal(transition.reason, 'one_evening_scene_transition')

  state.adventure.chapter = plan.target_scenes
  state.worldMemory.quests[0] = {
    id: `quest:chapter:${plan.target_scenes}`,
    status: 'completed',
    clock: { current: 2, max: 2, triggered: true },
  }
  state.autonomy.director_history = [
    { intent: { type: 'continue_exploration' } },
    { intent: { type: 'advance_quest_clock' } },
  ]
  const climax = authorizeDirectorIntent(state, { type: 'request_encounter', theme: 'undead', difficulty: 'medium' })
  assert.equal(climax.intent.type, 'request_encounter')
  assert.equal(climax.intent.theme, 'undead')
  assert.equal(climax.intent.difficulty, 'hard')
  assert.equal(climax.reason, 'one_evening_climax_encounter')
  assert.equal(campaignArcPosition(state).phase, 'climax')
})

test('one-evening climax requires a matching recorded hard encounter outcome', () => {
  const plan = buildCampaignArcPlan('climax-proof')
  const state = structuredClone(baseState)
  state.campaignConcept = { arc: plan }
  state.adventure.chapter = plan.target_scenes
  state.mechanics.encounter = {
    id: 'final-encounter',
    status: 'ended',
    difficulty: 'medium',
    created_in_chapter: plan.target_scenes,
  }
  state.autonomy.encounter_outcomes = [{ encounter_id: 'final-encounter', outcome: 'enemies_defeated' }]
  assert.equal(campaignArcClimaxSatisfied(state), false)

  state.mechanics.encounter.difficulty = 'hard'
  assert.equal(campaignArcClimaxSatisfied(state), true)
  state.mechanics.encounter.created_in_chapter -= 1
  assert.equal(campaignArcClimaxSatisfied(state), false)
  state.mechanics.encounter.created_in_chapter = plan.target_scenes
  state.autonomy.encounter_outcomes = [{ encounter_id: 'other-encounter', outcome: 'enemies_defeated' }]
  assert.equal(campaignArcClimaxSatisfied(state), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authorizeDirectorIntent,
  assembleSocialNpc,
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

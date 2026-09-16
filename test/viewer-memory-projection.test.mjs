import assert from 'node:assert/strict'
import test from 'node:test'

import { npcSocialForViewer } from '../server/npc-social.mjs'
import { worldMemoryForViewer } from '../server/world-memory.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const viewerFor = (playerId) => ({ role: 'player', heroIds: [playerId], isPartyMember: true })

function memoryProjectionState() {
  const deathGate = {
    visibility: 'gm_only', recorded_at_minutes: 10,
    source_event_ids: ['event:keeper-death'], fact_ids: ['fact:keeper-dead'],
    required_fact: { subject_id: 'npc:keeper', predicate: 'died' },
  }
  const knowledge = {
    id: 'knowledge:keeper-dead', hero_id: 'hero', fact_id: 'fact:keeper-dead',
    source_event_ids: ['event:keeper-death'], recorded_at_minutes: 10,
  }
  return {
    sessionCode: 'VIEWER-MEMORY', partyMemberIds: ['hero', 'rogue'], activePlayerId: 'hero',
    players: [
      { id: 'hero', character: 'Лира', hp: 10, maxHp: 10, x: 0, y: 0, inventory: [] },
      { id: 'rogue', character: 'Рог', hp: 10, maxHp: 10, x: 0, y: 0, inventory: [] },
    ],
    scene: {
      title: 'Архив', location: 'Архив', location_id: 'archive', objective: 'Найти печать',
      cells: [{ x: 0, y: 0, type: 'floor', revealed: true }],
    },
    adventure: { chapter: 1, currentHook: 'Найти печать', history: [], visitedLocations: ['Архив'] },
    mechanics: { world_time: { elapsed_minutes: 20 }, combat: { active: false }, positions: {} },
    campaignConcept: {
      story_sequence: 2, story_quest_id: 'quest:keeper',
      story_history: [{
        story_id: 'story:keeper', story_number: 3, quest_id: 'quest:keeper', title: 'Тайна хранителя',
        outcome: 'failure', summary: 'Скрытый исход.', knowledge_gate: deathGate,
        previous_view: {
          story_quest_id: 'quest:keeper', location_id: 'archive', objective: 'Осмотреть архив',
          current_hook: 'Осмотреть архив', replaced_objective: 'Найти печать', suggestions: [],
        },
      }],
    },
    worldMemory: {
      schema_version: 2,
      entities: [
        { id: 'npc:keeper', kind: 'npc', name: 'Хранитель', summary: 'Архивариус.', visibility: 'public' },
      ],
      facts: [{
        id: 'fact:keeper-dead', subject_id: 'npc:keeper', predicate: 'died', object: 'архив',
        summary: 'Хранитель погиб.', visibility: 'gm_only', status: 'active',
        source_event_ids: ['event:keeper-death'], recorded_at_minutes: 10,
      }],
      relationships: [],
      quests: [{
        id: 'quest:keeper', title: 'Найти печать', summary: 'Поручение хранителя.', status: 'failed',
        visibility: 'party', entity_ids: ['npc:keeper'], objectives: ['Найти печать'],
        clock: { current: 1, max: 4, label: 'Срок', triggered: false }, recorded_at_minutes: 10,
        knowledge_history: [{
          schema_version: 1, event_id: 'event:quest-failed', previous: { status: 'active', summary: 'Поручение хранителя.' },
          absent_fields: [], knowledge_gate: deathGate,
          previous_view: {
            location_id: 'archive', objective: 'Осмотреть архив', current_hook: 'Осмотреть архив',
            replaced_objective: 'Найти печать', suggestions: [],
          },
        }],
      }],
      threads: [], epistemic_claims: [], summaries: [],
      knowledge: { hero: ['fact:keeper-dead'] },
      knowledge_ledger: [knowledge], knowledge_revealed: [knowledge],
    },
    social: {
      npcs: [{
        id: 'npc:keeper', name: 'Хранитель', role: 'Архивариус', location: 'Архив', available: true, visibility: 'party',
        goals: ['Скрытая цель'], beliefs: ['Скрытое убеждение'], known_fact_ids: ['fact:keeper-dead'],
        dossier: [{ id: 'dossier:private', hero_id: 'hero', summary: 'Скрытая запись', visibility: 'gm_only' }],
      }],
      relationships: { 'npc:keeper': { hero: 10, rogue: -10 } }, relationship_tiers: {}, conversations: [], promises: [],
    },
    messages: [{ id: 'message:keeper', text: 'Хранитель погиб.', visibility: 'party', knowledge_gate: deathGate }],
  }
}

test('проекция кампании использует специализированные проекции памяти и NPC с прежними правами видимости', () => {
  const state = memoryProjectionState()
  const before = structuredClone(state)

  for (const playerId of ['hero', 'rogue']) {
    const viewer = viewerFor(playerId)
    const projected = campaignStateForViewer(state, viewer, playerId)
    const expectedMemory = worldMemoryForViewer(state.worldMemory, { playerId, isPartyMember: true })
    const expectedSocial = npcSocialForViewer(state.social, { playerId, isPartyMember: true, state })

    assert.deepEqual(projected.worldMemory, expectedMemory, `${playerId}: memory projection changed`)
    assert.deepEqual(projected.social, expectedSocial, `${playerId}: social projection changed`)
    assert.equal(projected.worldMemory.quests[0].knowledge_history, undefined)
    assert.equal(projected.social.npcs[0].dossier.length, 0)
  }

  const informed = campaignStateForViewer(state, viewerFor('hero'), 'hero')
  const uninformed = campaignStateForViewer(state, viewerFor('rogue'), 'rogue')
  assert.equal(informed.worldMemory.quests[0].status, 'failed')
  assert.equal(uninformed.worldMemory.quests[0].status, 'active')
  assert.equal(informed.campaignConcept.story_history.length, 1)
  assert.equal(uninformed.campaignConcept.story_history.length, 0)
  assert.equal(informed.messages.length, 1)
  assert.equal(uninformed.messages.length, 0)
  assert.equal(informed.scene.objective, 'Найти печать')
  assert.equal(uninformed.scene.objective, 'Осмотреть архив')
  assert.deepEqual(state, before, 'projection must not mutate authoritative memory or history')
})

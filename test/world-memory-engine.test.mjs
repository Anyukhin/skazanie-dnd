import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { retrieveWorldMemory, worldMemoryForViewer } from '../server/world-memory.mjs'

const diceService = new DiceService({ rng: new SequenceDiceRng([]) })

test('Rules Engine bridges relationships, threads, beliefs, rumors and summaries into replayable world memory', () => {
  const initial = normalizeCampaignState({
    sessionCode: 'WORLD-BRIDGE',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Hero', role: 'Воин', level: 1, hp: 10, maxHp: 10, abilities: { str: 14 }, inventory: [] }],
  })
  const commands = [
    { command_type: 'UpsertWorldEntity', entity: { id: 'npc:vela', kind: 'npc', name: 'Vela', visibility: 'party' } },
    { command_type: 'UpsertWorldEntity', entity: { id: 'faction:watch', kind: 'faction', name: 'Watch', visibility: 'party' } },
    { command_type: 'RecordWorldRelationship', relationship: {
      id: 'relationship:vela-watch', from_entity_id: 'npc:vela', relation: 'serves',
      to_entity_id: 'faction:watch', summary: 'Vela serves the Watch.', visibility: 'party',
      source_event_ids: ['event:appointment'],
    } },
    { command_type: 'UpsertNarrativeThread', thread: {
      id: 'thread:missing-key', title: 'The missing key', summary: 'The vault key is missing.',
      visibility: 'party', entity_ids: ['npc:vela'], clock: { current: 1, max: 4, label: 'Rivals close in' },
      source_event_ids: ['event:key-lost'],
    } },
    { command_type: 'RecordNpcBelief', claim: {
      id: 'belief:vela-thief', holder_entity_id: 'npc:vela', subject_entity_id: 'faction:watch',
      predicate: 'suspects', claim: 'Vela suspects a Watch officer.', summary: 'Vela suspects an officer.',
      visibility: 'gm_only', source_event_ids: ['event:suspicion'],
    } },
    { command_type: 'RecordRumor', claim: {
      id: 'rumor:market-key', holder_entity_id: 'npc:vela', predicate: 'heard',
      claim: 'The key was sold in the market.', summary: 'A market rumor.', visibility: 'party',
      source_event_ids: ['event:gossip'],
    } },
    { command_type: 'RecordNarrativeSummary', summary: {
      id: 'summary:session-1', kind: 'session', title: 'Session one',
      summary: 'The party learned that the vault key is missing.', visibility: 'party',
      entity_ids: ['npc:vela'], thread_ids: ['thread:missing-key'], source_event_ids: ['event:key-lost'],
    } },
  ]
  const result = resolveCommands(commands, initial, { diceService, context: { isDirector: true } })

  assert.deepEqual(result.events.map((event) => event.event_type), [
    'WorldEntityUpserted', 'WorldEntityUpserted', 'WorldRelationshipRecorded',
    'NarrativeThreadUpserted', 'NpcBeliefRecorded', 'RumorRecorded', 'NarrativeSummaryRecorded',
  ])
  assert.deepEqual(replayEvents(initial, result.events), result.state)
  const playerMemory = worldMemoryForViewer(result.state.worldMemory, { playerId: 'hero', isPartyMember: true })
  assert.equal(playerMemory.epistemic_claims.some((claim) => claim.id === 'belief:vela-thief'), false)
  assert.equal(playerMemory.epistemic_claims.some((claim) => claim.id === 'rumor:market-key'), true)
  const retrieved = retrieveWorldMemory(result.state.worldMemory, { playerId: 'hero', isPartyMember: true }, { query: 'слух о базаре ключ', limit: 5 })
  assert.equal(retrieved.some((entry) => entry.id === 'rumor:market-key'), true)
  assert.equal(retrieved.some((entry) => entry.id === 'belief:vela-thief'), false)
})

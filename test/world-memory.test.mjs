import assert from 'node:assert/strict'
import test from 'node:test'

import { answerKnownLore } from '../server/agent-router.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import {
  RulesValidationError,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
  resolveCommands,
} from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import {
  applyWorldMemoryEvent,
  normalizeWorldMemory,
  retrieveKnownWorldMemory,
  retrieveWorldMemory,
  validateWorldMemoryCommand,
  worldMemoryEvent,
  worldMemoryForViewer,
} from '../server/world-memory.mjs'

function dice() {
  return new DiceService({ rng: new SequenceDiceRng([]) })
}

function campaign() {
  return normalizeCampaignState({
    sessionCode: 'WORLD-MEMORY',
    activePlayerId: 'hero',
    partyMemberIds: ['hero', 'rogue'],
    scene: { title: 'Archive', location: 'North Gate', cells: [] },
    players: [
      { id: 'hero', character: 'Ada', hp: 10, maxHp: 10, inventory: [] },
      { id: 'rogue', character: 'Ren', hp: 10, maxHp: 10, inventory: [] },
    ],
  })
}

function buildMemory(initialState = campaign()) {
  return resolveCommands([
    {
      command_type: 'UpsertWorldEntity',
      entity: { id: 'npc:ashen-fox', kind: 'npc', name: 'Ashen Fox', summary: 'A masked courier.', visibility: 'gm_only' },
    },
    {
      command_type: 'RecordWorldFact',
      fact: {
        id: 'fact:fox-route', subject_id: 'npc:ashen-fox', predicate: 'uses_route',
        object: 'The courier uses the old aqueduct.', summary: 'Ashen Fox uses the old aqueduct.', visibility: 'gm_only',
      },
    },
    { command_type: 'RevealWorldFact', fact_id: 'fact:fox-route', target_ids: ['hero'] },
    {
      command_type: 'UpsertQuest',
      quest: {
        id: 'quest:find-seal', title: 'Find the Seal', summary: 'Recover the archive seal.',
        objectives: ['Go to the archive vault'], visibility: 'party', clock: { current: 1, max: 3, label: 'Rivals arrive' },
      },
    },
    { command_type: 'AdvanceQuestClock', quest_id: 'quest:find-seal', amount: 2 },
  ], initialState, { diceService: dice(), context: { isAdmin: true } })
}

function runWorldMemoryCommands(initialState, commands) {
  let state = { ...initialState, worldMemory: normalizeWorldMemory(initialState.worldMemory) }
  const events = []
  for (const [index, raw] of commands.entries()) {
    const command = validateWorldMemoryCommand({ ...raw, command_id: raw.command_id ?? `memory-command:${index + 1}` }, state, { isDirector: true })
    const emitted = worldMemoryEvent(command)
    assert.ok(emitted, `world-memory command ${command.command_type} must emit an event`)
    const event = { ...emitted, event_id: `memory-event:${index + 1}`, command_id: command.command_id }
    events.push(event)
    state = { ...state, worldMemory: applyWorldMemoryEvent(state.worldMemory, event) }
  }
  return { state, events }
}

test('world entities, facts, knowledge, quests and clocks are event sourced and replayable', () => {
  const initialState = campaign()
  const result = buildMemory(initialState)

  assert.deepEqual(result.events.map((event) => event.event_type), [
    'WorldEntityUpserted', 'WorldFactRecorded', 'WorldFactRevealed', 'QuestUpserted', 'QuestClockAdvanced',
  ])
  assert.deepEqual(result.state.worldMemory.knowledge.hero, ['fact:fox-route'])
  assert.equal(result.state.worldMemory.quests[0].clock.current, 3)
  assert.equal(result.state.worldMemory.quests[0].clock.triggered, true)
  assert.deepEqual(replayEvents(initialState, result.events), result.state)
})

test('a private fact is visible only to the hero who learned it', () => {
  const state = buildMemory().state
  const hero = worldMemoryForViewer(state.worldMemory, { playerId: 'hero', isPartyMember: true })
  const rogue = worldMemoryForViewer(state.worldMemory, { playerId: 'rogue', isPartyMember: true })

  assert.deepEqual(hero.facts.map((fact) => fact.id), ['fact:fox-route'])
  assert.ok(hero.entities.some((entity) => entity.id === 'npc:ashen-fox'))
  assert.deepEqual(rogue.facts, [])
  assert.ok(!rogue.entities.some((entity) => entity.id === 'npc:ashen-fox'))
  assert.equal(hero.quests.find((quest) => quest.id === 'quest:find-seal').title, 'Find the Seal')
  assert.equal(rogue.quests.find((quest) => quest.id === 'quest:find-seal').title, 'Find the Seal')

  const projected = campaignStateForViewer(state, { role: 'player', heroIds: ['rogue'] }, 'rogue')
  assert.doesNotMatch(JSON.stringify(projected), /old aqueduct|Ashen Fox/u)
  assert.equal(hero.knowledge_ledger[0].fact_id, 'fact:fox-route')
  assert.equal(hero.knowledge_ledger[0].hero_id, 'hero')
  assert.equal(rogue.knowledge_ledger.length, 0)
})

test('legacy knowledge migrates to a versioned ledger and retrieval filters before ranking', () => {
  const state = buildMemory().state
  const migrated = normalizeCampaignState({
    ...state,
    worldMemory: {
      ...state.worldMemory,
      knowledge_ledger: undefined,
      knowledge: { hero: ['fact:fox-route'] },
    },
  })
  assert.equal(migrated.worldMemory.schema_version, 2)
  assert.equal(migrated.worldMemory.knowledge_ledger[0].source_kind, 'legacy')

  const hero = retrieveKnownWorldMemory(state.worldMemory, {
    viewer: { playerId: 'hero', isPartyMember: true },
    query: 'aqueduct',
  })
  const rogue = retrieveKnownWorldMemory(state.worldMemory, {
    viewer: { playerId: 'rogue', isPartyMember: true },
    query: 'aqueduct',
  })
  assert.deepEqual(hero.map((fact) => fact.id), ['fact:fox-route'])
  assert.deepEqual(rogue, [])
  assert.deepEqual(hero[0].citation.knowledge_entry_ids.length, 1)

  const learnedLater = structuredClone(state.worldMemory)
  learnedLater.knowledge_ledger[0].recorded_at_minutes = 60
  learnedLater.knowledge_revealed[0].recorded_at_minutes = 60
  assert.deepEqual(retrieveKnownWorldMemory(learnedLater, {
    viewer: { playerId: 'hero', isPartyMember: true }, query: 'aqueduct', atMinutes: 0,
  }), [])
})

test('canonical relationships, threads, epistemic claims and summaries replay without becoming facts', () => {
  const initial = campaign()
  const result = runWorldMemoryCommands(initial, [
    { command_type: 'UpsertWorldEntity', entity: { id: 'npc:vela', kind: 'npc', name: 'Vela', visibility: 'party' } },
    { command_type: 'UpsertWorldEntity', entity: { id: 'faction:wardens', kind: 'faction', name: 'Road Wardens', visibility: 'party' } },
    { command_type: 'UpsertWorldEntity', entity: { id: 'location:ford', kind: 'location', name: 'Ash Ford', aliases: ['old trail'], visibility: 'party' } },
    { command_type: 'RecordWorldFact', fact: {
      id: 'fact:ford-closed', subject_id: 'location:ford', predicate: 'is_closed', object: 'The old trail is flooded.',
      summary: 'Ash Ford is closed after the flood.', visibility: 'party', source_event_ids: ['event:flood'],
    } },
    { command_type: 'RecordWorldRelationship', relationship: {
      id: 'relationship:vela-wardens', from_entity_id: 'npc:vela', relation: 'serves', to_entity_id: 'faction:wardens',
      summary: 'Vela serves the Road Wardens.', visibility: 'party', source_event_ids: ['event:oath'],
    } },
    { command_type: 'UpsertQuest', quest: { id: 'quest:ford', title: 'Cross Ash Ford', visibility: 'party', entity_ids: ['location:ford'], clock: { current: 0, max: 3, label: 'Flood rises' } } },
    { command_type: 'UpsertNarrativeThread', thread: {
      id: 'thread:warden-oath', title: 'The warden oath', summary: 'Vela needs proof before guiding the party.', status: 'active', visibility: 'party',
      entity_ids: ['npc:vela', 'faction:wardens'], quest_ids: ['quest:ford'], clock: { current: 1, max: 3, label: 'Trust' }, source_event_ids: ['event:oath'],
    } },
    { command_type: 'AdvanceNarrativeThreadClock', thread_id: 'thread:warden-oath', amount: 1 },
    { command_type: 'RecordNpcBelief', claim: {
      id: 'belief:vela-river', holder_entity_id: 'npc:vela', subject_entity_id: 'location:ford', predicate: 'caused_flood',
      claim: 'Vela believes the Wardens opened the sluice gate.', summary: 'Vela suspects the Wardens.', visibility: 'gm_only', source_event_ids: ['event:vela-told'],
    } },
    { command_type: 'RecordRumor', claim: {
      id: 'rumor:vela-smugglers', holder_entity_id: 'npc:vela', subject_entity_id: 'location:ford', predicate: 'smugglers_arrived',
      claim: 'Travellers say smugglers use the old trail.', summary: 'A rumour ties smugglers to Ash Ford.', visibility: 'party', source_event_ids: ['event:travellers'],
    } },
    { command_type: 'ResolveEpistemicClaim', claim_id: 'rumor:vela-smugglers', truth_status: 'refuted', source_event_ids: ['event:search'] },
    { command_type: 'RecordNarrativeSummary', summary: {
      id: 'summary:scene-ford', kind: 'scene', title: 'At Ash Ford', summary: 'The party learned that Vela serves the Wardens and the ford is closed.',
      visibility: 'party', entity_ids: ['npc:vela', 'location:ford'], thread_ids: ['thread:warden-oath'], source_event_ids: ['event:oath', 'event:flood'],
    } },
  ])

  assert.deepEqual(result.events.map((event) => event.event_type), [
    'WorldEntityUpserted', 'WorldEntityUpserted', 'WorldEntityUpserted', 'WorldFactRecorded', 'WorldRelationshipRecorded',
    'QuestUpserted', 'NarrativeThreadUpserted', 'NarrativeThreadClockAdvanced', 'NpcBeliefRecorded', 'RumorRecorded',
    'EpistemicClaimTruthResolved', 'NarrativeSummaryRecorded',
  ])
  assert.equal(result.state.worldMemory.relationships[0].status, 'active')
  assert.equal(result.state.worldMemory.threads[0].clock.current, 2)
  assert.equal(result.state.worldMemory.epistemic_claims.find((claim) => claim.id === 'belief:vela-river').truth_status, 'unknown')
  assert.equal(result.state.worldMemory.epistemic_claims.find((claim) => claim.id === 'rumor:vela-smugglers').truth_status, 'refuted')
  assert.equal(result.state.worldMemory.summaries[0].source_event_ids.length, 2)
  assert.equal(result.state.worldMemory.facts.some((fact) => fact.id === 'rumor:vela-smugglers'), false)

  const replayed = result.events.reduce((memory, event) => applyWorldMemoryEvent(memory, event), normalizeWorldMemory(initial.worldMemory))
  assert.deepEqual(replayed, result.state.worldMemory)
})

test('epistemic and summary validation require provenance, while viewer retrieval filters before semantic ranking and time', () => {
  const initial = campaign()
  const seeded = runWorldMemoryCommands(initial, [
    { command_type: 'UpsertWorldEntity', entity: { id: 'npc:vela', kind: 'npc', name: 'Vela', visibility: 'party' } },
    { command_type: 'UpsertWorldEntity', entity: { id: 'location:ford', kind: 'location', name: 'Ash Ford', aliases: ['old trail'], visibility: 'party' } },
    { command_type: 'RecordWorldFact', fact: { id: 'fact:ford-route', subject_id: 'location:ford', predicate: 'blocks_route', object: 'The old trail is flooded.', summary: 'The old trail cannot be used.', visibility: 'party', source_event_ids: ['event:flood'] } },
    { command_type: 'RecordRumor', claim: { id: 'rumor:party', holder_entity_id: 'npc:vela', claim: 'Smugglers crossed the ford.', summary: 'A visible rumour.', visibility: 'party', source_event_ids: ['event:talk'] } },
    { command_type: 'RecordNpcBelief', claim: { id: 'belief:hidden', holder_entity_id: 'npc:vela', claim: 'Vela thinks the party is being watched.', summary: 'A hidden belief.', visibility: 'gm_only', source_event_ids: ['event:thought'] } },
  ])
  const laterState = { ...seeded.state, mechanics: { ...seeded.state.mechanics, world_time: { elapsed_minutes: 120 } } }
  const withSummary = runWorldMemoryCommands(laterState, [{ command_type: 'RecordNarrativeSummary', summary: {
    id: 'summary:later', kind: 'session', title: 'Later session', summary: 'The party considers a route through the ford.', visibility: 'party', source_event_ids: ['event:later'],
  } }]).state

  const playerMemory = worldMemoryForViewer(withSummary.worldMemory, { playerId: 'hero', isPartyMember: true })
  assert.equal(playerMemory.epistemic_claims.some((claim) => claim.id === 'belief:hidden'), false)
  assert.equal(playerMemory.epistemic_claims.some((claim) => claim.id === 'rumor:party'), true)
  assert.ok(retrieveWorldMemory(withSummary.worldMemory, { playerId: 'hero', isPartyMember: true }, { query: 'маршрут', limit: 5 }).some((entry) => entry.id === 'fact:ford-route'))
  assert.equal(retrieveWorldMemory(withSummary.worldMemory, { playerId: 'hero', isPartyMember: true }, { query: 'later', asOfMinutes: 0 }).some((entry) => entry.id === 'summary:later'), false)

  assert.throws(
    () => validateWorldMemoryCommand({ command_type: 'RecordNpcBelief', command_id: 'invalid-holder', claim: { id: 'belief:invalid', holder_entity_id: 'location:ford', claim: 'Not an NPC.' } }, withSummary, { isDirector: true }),
    (error) => error.code === 'WORLD_NPC_BELIEF_HOLDER_INVALID',
  )
  assert.throws(
    () => validateWorldMemoryCommand({ command_type: 'RecordNarrativeSummary', command_id: 'missing-provenance', summary: { id: 'summary:invalid', kind: 'scene', title: 'Invalid', summary: 'No evidence.' } }, withSummary, { isDirector: true }),
    (error) => error.code === 'WORLD_SUMMARY_PROVENANCE_REQUIRED',
  )
})

test('players cannot forge world memory and unknown nested fields are rejected', () => {
  const state = campaign()
  assert.throws(
    () => resolveCommand({ command_type: 'UpsertWorldEntity', entity: { id: 'npc:x', kind: 'npc', name: 'X' } }, state, { diceService: dice(), context: {} }),
    (error) => error instanceof RulesValidationError && error.code === 'WORLD_MEMORY_FORBIDDEN',
  )
  assert.throws(
    () => resolveCommand({ command_type: 'UpsertWorldEntity', entity: { id: 'npc:x', kind: 'npc', name: 'X', secret_prompt: 'leak' } }, state, { diceService: dice(), context: { isAdmin: true } }),
    (error) => error instanceof RulesValidationError && error.code === 'WORLD_MEMORY_UNKNOWN_FIELD',
  )
})

test('superseding a fact preserves history but retires the old assertion', () => {
  const first = buildMemory().state
  const result = resolveCommand({
    command_type: 'RecordWorldFact',
    fact: {
      id: 'fact:fox-route-new', subject_id: 'npc:ashen-fox', predicate: 'uses_route',
      object: 'The aqueduct is compromised.', supersedes_fact_id: 'fact:fox-route', visibility: 'gm_only',
    },
  }, first, { diceService: dice(), context: { isDirector: true } })
  const state = replayEvents(first, result.events)

  assert.equal(state.worldMemory.facts.find((fact) => fact.id === 'fact:fox-route').status, 'superseded')
  assert.equal(state.worldMemory.facts.find((fact) => fact.id === 'fact:fox-route-new').status, 'active')
})

test('Worldkeeper answers only from the viewer projection and uses no LLM turn', async () => {
  const state = buildMemory().state
  const heroMemory = worldMemoryForViewer(state.worldMemory, { playerId: 'hero', isPartyMember: true })
  const lore = answerKnownLore('\u0447\u0442\u043e \u044f \u0437\u043d\u0430\u044e \u043f\u0440\u043e Ashen Fox?', { ...state, worldMemory: heroMemory })
  assert.match(lore.narration, /old aqueduct/u)
  assert.equal(lore.turn_consumed, false)

  let parserCalls = 0
  const orchestrator = new GameOrchestrator({
    modeResolver: () => 'enforce',
    intentParser: { parse: async () => { parserCalls += 1; throw new Error('LLM parser must not run') } },
    rulesEngine: {},
    eventStore: {},
    idFactory: () => 'lore-turn',
  })
  const response = await orchestrator.handle({
    state,
    playerId: 'hero',
    message: '\u0447\u0442\u043e \u044f \u0437\u043d\u0430\u044e \u043f\u0440\u043e Ashen Fox?',
    user: { role: 'player' },
  })
  assert.equal(parserCalls, 0)
  assert.equal(response.provider, 'AgentWorldkeeper')
  assert.equal(response.turn_consumed, false)
  assert.match(response.narration, /old aqueduct/u)
})

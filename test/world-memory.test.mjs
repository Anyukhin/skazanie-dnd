import assert from 'node:assert/strict'
import test from 'node:test'

import { answerKnownLore } from '../server/player-request-router.mjs'
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
  diagnoseWorldMemory,
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

test('triggered quest clock resolves through a typed event and rejects premature resolution', () => {
  const initialState = campaign()
  assert.throws(
    () => runWorldMemoryCommands(initialState, [{
      command_type: 'UpsertQuest',
      quest: { id: 'quest:early', title: 'Too early', status: 'active', visibility: 'party', clock: { current: 0, max: 2, label: 'Progress' } },
    }, {
      command_type: 'ResolveQuest',
      quest_id: 'quest:early',
      outcome: 'success',
      summary: 'Not yet.',
      next_objective: 'Wait.',
    }]),
    (error) => error.code === 'WORLD_QUEST_CLOCK_NOT_TRIGGERED',
  )

  const prepared = buildMemory(initialState)
  const resolved = runWorldMemoryCommands(prepared.state, [{
    command_type: 'ResolveQuest',
    quest_id: 'quest:find-seal',
    outcome: 'failure',
    summary: 'The rivals reached the seal first.',
    next_objective: 'Recover the seal from the rivals.',
    source_event_ids: [prepared.events.at(-1).event_id],
  }])

  assert.equal(resolved.events[0].event_type, 'QuestResolved')
  assert.equal(resolved.state.worldMemory.quests[0].status, 'failed')
  assert.match(resolved.state.worldMemory.quests[0].summary, /rivals reached/u)
})

test('отказ отряда закрывает квест до заполнения часов, а успех и провал — нет', () => {
  const initialState = campaign()
  // Часы у квеста стоят на 1 из 3: обычная развязка здесь запрещена, а отказ —
  // единственный исход, который отряд объявляет своим решением, а не развязкой.
  const prepared = resolveCommands([{
    command_type: 'UpsertQuest',
    quest: {
      id: 'quest:find-seal', title: 'Find the Seal', summary: 'Recover the archive seal.',
      objectives: ['Go to the archive vault'], visibility: 'party', clock: { current: 1, max: 3, label: 'Rivals arrive' },
    },
  }], initialState, { diceService: dice(), context: { isAdmin: true } })

  assert.throws(
    () => runWorldMemoryCommands(prepared.state, [{
      command_type: 'ResolveQuest', quest_id: 'quest:find-seal', outcome: 'success',
      summary: 'Not yet.', next_objective: 'Wait.',
    }]),
    (error) => error.code === 'WORLD_QUEST_CLOCK_NOT_TRIGGERED',
  )
  assert.throws(
    () => runWorldMemoryCommands(prepared.state, [{
      command_type: 'ResolveQuest', quest_id: 'quest:find-seal', outcome: 'walked-away',
      summary: 'Nope.', next_objective: 'Nope.',
    }]),
    (error) => error.code === 'WORLD_QUEST_OUTCOME_INVALID',
  )

  const abandoned = runWorldMemoryCommands(prepared.state, [{
    command_type: 'ResolveQuest', quest_id: 'quest:find-seal', outcome: 'abandoned',
    summary: 'Отряд отказался от задания и ушёл из архива.',
    next_objective: 'Осмотреться в новом месте и найти новую цель',
    request_fingerprint: 'director-transition-fingerprint',
  }])

  assert.equal(abandoned.events[0].event_type, 'QuestResolved')
  assert.equal(abandoned.events[0].payload.status, 'abandoned')
  assert.equal(abandoned.events[0].payload.request_fingerprint, 'director-transition-fingerprint')
  assert.equal(abandoned.state.worldMemory.quests[0].status, 'abandoned')
  assert.deepEqual(replayEvents(prepared.state, abandoned.events).worldMemory, abandoned.state.worldMemory)

  // Закрытый отказом квест дальше ведёт себя как любой закрытый: часы у него уже
  // не двигаются, и повторно разрешить его нельзя.
  assert.throws(
    () => runWorldMemoryCommands(abandoned.state, [{ command_type: 'AdvanceQuestClock', quest_id: 'quest:find-seal', amount: 1 }]),
    (error) => error.code === 'WORLD_QUEST_CLOSED',
  )
})

test('развязка без отпечатка запроса собирает прежний payload без нового поля', () => {
  const event = worldMemoryEvent({
    command_type: 'ResolveQuest', quest_id: 'quest:find-seal', outcome: 'success',
    summary: 'Done.', next_objective: 'Next.', source_event_ids: [],
  })
  assert.equal(Object.hasOwn(event.payload, 'request_fingerprint'), false)
  assert.equal(event.payload.status, 'completed')
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

test('нормализация сохраняет память за прежними пределами коллекций', () => {
  const entities = Array.from({ length: 501 }, (_, index) => ({
    id: `npc:long-${index}`,
    kind: 'npc',
    name: `Long NPC ${index}`,
    visibility: 'gm_only',
  }))
  const facts = Array.from({ length: 2_001 }, (_, index) => ({
    id: `fact:long-${index}`,
    subject_id: `npc:long-${index % entities.length}`,
    predicate: 'remembered',
    object: `Fact ${index}`,
    visibility: 'gm_only',
  }))
  const relationships = Array.from({ length: 2_001 }, (_, index) => ({
    id: `relationship:long-${index}`,
    from_entity_id: `npc:long-${index % entities.length}`,
    relation: 'knows',
    to_entity_id: `npc:long-${(index + 1) % entities.length}`,
    summary: `Relationship ${index}`,
    visibility: 'gm_only',
  }))
  const quests = Array.from({ length: 301 }, (_, index) => ({
    id: `quest:long-${index}`,
    title: `Quest ${index}`,
    summary: `Quest summary ${index}`,
    status: 'active',
    visibility: 'gm_only',
  }))
  const threads = Array.from({ length: 501 }, (_, index) => ({
    id: `thread:long-${index}`,
    title: `Thread ${index}`,
    summary: `Thread summary ${index}`,
    status: 'active',
    visibility: 'gm_only',
  }))
  const claims = Array.from({ length: 2_001 }, (_, index) => ({
    id: `belief:long-${index}`,
    holder_entity_id: `npc:long-${index % entities.length}`,
    claim: `Belief ${index}`,
    visibility: 'gm_only',
  }))
  const summaries = Array.from({ length: 1_001 }, (_, index) => ({
    id: `summary:long-${index}`,
    kind: 'scene',
    title: `Summary ${index}`,
    summary: `Summary text ${index}`,
    visibility: 'gm_only',
  }))
  const knowledge_ledger = Array.from({ length: 5_001 }, (_, index) => ({
    id: `knowledge:long-${index}`,
    hero_id: 'hero',
    fact_id: `fact:long-${index % facts.length}`,
    source_kind: 'knowledge_revealed',
  }))

  const normalized = normalizeWorldMemory({ entities, facts, relationships, quests, threads, epistemic_claims: claims, summaries, knowledge_ledger })

  assert.equal(normalized.entities.length, entities.length)
  assert.equal(normalized.facts.length, facts.length)
  assert.equal(normalized.relationships.length, relationships.length)
  assert.equal(normalized.quests.length, quests.length)
  assert.equal(normalized.threads.length, threads.length)
  assert.equal(normalized.epistemic_claims.length, claims.length)
  assert.equal(normalized.summaries.length, summaries.length)
  assert.equal(normalized.knowledge_ledger.length, knowledge_ledger.length)
  assert.ok(normalized.entities.some((entry) => entry.id === 'npc:long-500'))
  assert.ok(normalized.facts.some((entry) => entry.id === 'fact:long-2000'))
  assert.ok(normalized.relationships.some((entry) => entry.id === 'relationship:long-2000'))
  assert.ok(normalized.quests.some((entry) => entry.id === 'quest:long-300'))
  assert.ok(normalized.threads.some((entry) => entry.id === 'thread:long-500'))
  assert.ok(normalized.epistemic_claims.some((entry) => entry.id === 'belief:long-2000'))
  assert.ok(normalized.summaries.some((entry) => entry.id === 'summary:long-1000'))
  assert.ok(normalized.knowledge.hero.includes(`fact:long-${5_000 % facts.length}`))

  const legacy = normalizeWorldMemory({ entities, facts, knowledge: {
    hero: facts.map((fact) => fact.id),
  } })
  assert.equal(legacy.knowledge_ledger.length, facts.length)
  assert.equal(legacy.knowledge_ledger.at(-1).fact_id, 'fact:long-2000')
})

test('нормализация сохраняет замещённый и новый факт и диагностирует битые ссылки', () => {
  const input = {
    entities: [{ id: 'npc:keeper', kind: 'npc', name: 'Keeper', visibility: 'gm_only' }],
    facts: [
      { id: 'fact:old', subject_id: 'npc:keeper', predicate: 'holds', object: 'old', status: 'superseded', visibility: 'gm_only' },
      { id: 'fact:new', subject_id: 'npc:keeper', predicate: 'holds', object: 'new', supersedes_fact_id: 'fact:old', visibility: 'gm_only' },
      { id: 'fact:broken', subject_id: 'npc:missing', predicate: 'holds', object: 'unknown', visibility: 'gm_only' },
    ],
    relationships: [{ id: 'relationship:broken', from_entity_id: 'npc:keeper', relation: 'knows', to_entity_id: 'npc:missing', summary: 'Unknown target', visibility: 'gm_only' }],
    quests: [{ id: 'quest:broken', title: 'Broken quest', summary: 'Unknown entity', entity_ids: ['npc:missing'], visibility: 'gm_only' }],
    threads: [{ id: 'thread:broken', title: 'Broken thread', summary: 'Unknown quest', entity_ids: ['npc:keeper'], quest_ids: ['quest:missing'], visibility: 'gm_only' }],
    epistemic_claims: [{ id: 'belief:broken', holder_entity_id: 'npc:keeper', subject_entity_id: 'npc:missing', claim: 'Unknown target', visibility: 'gm_only' }],
    summaries: [{ id: 'summary:broken', kind: 'scene', title: 'Broken summary', summary: 'Unknown references', entity_ids: ['npc:missing'], thread_ids: ['thread:missing'], visibility: 'gm_only' }],
    knowledge_ledger: [{ id: 'knowledge:broken', hero_id: 'hero', fact_id: 'fact:missing' }],
  }

  const normalized = normalizeWorldMemory(input)
  assert.deepEqual(normalized.facts.map((entry) => entry.id), ['fact:old', 'fact:new', 'fact:broken'])
  assert.equal(normalized.facts.find((entry) => entry.id === 'fact:old').status, 'superseded')
  assert.equal(normalized.facts.find((entry) => entry.id === 'fact:new').supersedes_fact_id, 'fact:old')
  assert.equal(normalized.relationships.length, 1)
  assert.equal(normalized.quests.length, 1)
  assert.equal(normalized.threads.length, 1)
  assert.equal(normalized.epistemic_claims.length, 1)
  assert.equal(normalized.summaries.length, 1)
  assert.equal(normalized.knowledge_ledger.length, 1)

  const diagnostics = diagnoseWorldMemory(normalized)
  assert.ok(diagnostics.some((issue) => issue.collection === 'facts' && issue.id === 'fact:broken' && issue.field === 'subject_id'))
  assert.ok(diagnostics.some((issue) => issue.collection === 'relationships' && issue.id === 'relationship:broken' && issue.field === 'to_entity_id'))
  assert.ok(diagnostics.some((issue) => issue.collection === 'quests' && issue.id === 'quest:broken' && issue.field === 'entity_ids'))
  assert.ok(diagnostics.some((issue) => issue.collection === 'threads' && issue.id === 'thread:broken' && issue.field === 'quest_ids'))
  assert.ok(diagnostics.some((issue) => issue.collection === 'epistemic_claims' && issue.id === 'belief:broken' && issue.field === 'subject_entity_id'))
  assert.ok(diagnostics.some((issue) => issue.collection === 'summaries' && issue.id === 'summary:broken' && issue.field === 'entity_ids'))
  assert.ok(diagnostics.some((issue) => issue.collection === 'knowledge_ledger' && issue.id === 'knowledge:broken' && issue.field === 'fact_id'))
})

test('нормализация идемпотентна для корректной памяти и диагностики', () => {
  const input = {
    entities: [{ id: 'npc:keeper', kind: 'npc', name: 'Keeper', visibility: 'gm_only' }],
    facts: [{ id: 'fact:keeper', subject_id: 'npc:keeper', predicate: 'waits', object: 'Here', visibility: 'gm_only' }],
    relationships: [], quests: [], threads: [], epistemic_claims: [], summaries: [],
    knowledge_ledger: [{ id: 'knowledge:keeper', hero_id: 'hero', fact_id: 'fact:keeper' }],
  }
  const once = normalizeWorldMemory(input)
  assert.deepEqual(normalizeWorldMemory(once), once)
  assert.deepEqual(diagnoseWorldMemory(once), diagnoseWorldMemory(normalizeWorldMemory(once)))
})

test('редьюсеры памяти добавляют знание и сводки без вытеснения старых записей', () => {
  const memory = normalizeWorldMemory({
    entities: [{ id: 'npc:keeper', kind: 'npc', name: 'Keeper', visibility: 'gm_only' }],
    facts: [{ id: 'fact:keeper', subject_id: 'npc:keeper', predicate: 'waits', object: 'Here', visibility: 'gm_only' }],
    summaries: Array.from({ length: 1_000 }, (_, index) => ({
      id: `summary:old-${index}`, kind: 'scene', title: `Old ${index}`, summary: `Old summary ${index}`, visibility: 'gm_only',
    })),
    knowledge_ledger: Array.from({ length: 5_000 }, (_, index) => ({
      id: `knowledge:old-${index}`, hero_id: 'hero', fact_id: 'fact:keeper', source_kind: 'knowledge_revealed',
    })),
  })
  const afterKnowledge = applyWorldMemoryEvent(memory, {
    event_type: 'KnowledgeRevealed', event_id: 'knowledge:new', target_ids: ['hero'],
    payload: { fact_id: 'fact:keeper' },
  })
  const afterSummary = applyWorldMemoryEvent(afterKnowledge, {
    event_type: 'NarrativeSummaryRecorded', event_id: 'summary:new',
    payload: { summary: { id: 'summary:new', kind: 'scene', title: 'New', summary: 'New summary', visibility: 'gm_only' } },
  })
  assert.equal(afterKnowledge.knowledge_ledger.length, 5_001)
  assert.equal(afterKnowledge.knowledge_ledger[0].id, 'knowledge:old-0')
  assert.equal(afterSummary.summaries.length, 1_001)
  assert.equal(afterSummary.summaries[0].id, 'summary:old-0')
})

test('историческая проекция игрока скрывает последствие до раскрытия знания', () => {
  const memory = normalizeWorldMemory({
    entities: [{ id: 'npc:keeper', kind: 'npc', name: 'Keeper', visibility: 'party' }],
    facts: [{
      id: 'fact:keeper-dead', subject_id: 'npc:keeper', predicate: 'died', object: 'North Gate',
      summary: 'Keeper died at the North Gate.', visibility: 'gm_only', recorded_at_minutes: 100, source_event_ids: ['event:death'],
    }],
    quests: [{
      id: 'quest:keeper', title: 'Meet the keeper', summary: 'Find the keeper.', status: 'failed', visibility: 'party',
      knowledge_history: [{
        schema_version: 1, event_id: 'event:quest-invalidated',
        previous: { status: 'active', summary: 'Find the keeper.' },
        knowledge_gate: { visibility: 'gm_only', recorded_at_minutes: 100, source_event_ids: ['event:death'], fact_ids: ['fact:keeper-dead'] },
      }],
    }],
    knowledge_ledger: [{
      id: 'knowledge:death', hero_id: 'hero', fact_id: 'fact:keeper-dead', recorded_at_minutes: 200,
      source_kind: 'knowledge_revealed',
    }],
  })
  const beforeReveal = worldMemoryForViewer(memory, { playerId: 'hero', isPartyMember: true, asOfMinutes: 150 })
  const afterReveal = worldMemoryForViewer(memory, { playerId: 'hero', isPartyMember: true, asOfMinutes: 250 })
  const admin = worldMemoryForViewer(memory, { isAdmin: true })
  assert.equal(beforeReveal.quests.find((quest) => quest.id === 'quest:keeper').status, 'active')
  assert.equal(afterReveal.quests.find((quest) => quest.id === 'quest:keeper').status, 'failed')
  assert.equal(admin.quests.find((quest) => quest.id === 'quest:keeper').knowledge_history.length, 1)
  assert.equal(Object.hasOwn(beforeReveal.quests[0], 'knowledge_history'), false)
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

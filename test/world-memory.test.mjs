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
import { worldMemoryForViewer } from '../server/world-memory.mjs'

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

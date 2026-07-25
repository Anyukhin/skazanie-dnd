import assert from 'node:assert/strict'
import test from 'node:test'

import { answerKnownLore } from '../server/agent-router.mjs'
import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { ensureSceneWorldMemory, questTitleFromObjective } from '../server/scene-memory.mjs'
import { worldMemoryForViewer } from '../server/world-memory.mjs'

function dice() {
  return new DiceService({ rng: new SequenceDiceRng([]) })
}

function initialState() {
  return normalizeCampaignState({
    sessionCode: 'SCENE-MEMORY',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Ada', hp: 10, maxHp: 10, inventory: [] }],
    scene: {
      title: 'Sunken Archive', location: 'Sunken Archive', mood: 'Silent halls',
      objective: 'Recover the archivist seal', turn: 1,
      cells: [{ x: 1, y: 1, type: 'floor', revealed: true }],
    },
    adventure: {
      chapter: 1,
      currentHook: 'The seal opens the northern vault',
      unresolvedThreads: ['The seal opens the northern vault'],
      visitedLocations: ['Sunken Archive'],
      history: [],
    },
  })
}

function advance(state, objectiveStatus = 'completed') {
  return resolveCommands([{
    command_type: 'AdvanceScene',
    command_id: `advance-${objectiveStatus}`,
    scene_args: {
      title: 'Chapter 2 - Moon Harbor',
      location: 'Moon Harbor',
      mood: 'Cold lanterns above the tide',
      objective: 'Find Captain Vale',
      hook: 'Captain Vale knows who bought the stolen seal',
      transition: 'The party leaves the archive and follows the river to Moon Harbor.',
      arrival: 'Moon Harbor appears through the fog, its lighthouse dark.',
      completed_objective: 'Recover the archivist seal',
      objective_status: objectiveStatus,
      outcome: objectiveStatus === 'completed' ? 'The party recovered the archivist seal.' : 'The seal remains hidden in the archive.',
      carry_unresolved: objectiveStatus === 'unresolved',
      theme: 'harbor',
      danger: 'средняя',
    },
  }], state, { diceService: dice(), context: { isAdmin: true } })
}

test('legacy scene state deterministically seeds a location and current quest', () => {
  const first = initialState()
  const second = normalizeCampaignState(first)

  assert.equal(first.worldMemory.entities.length, 1)
  assert.equal(first.worldMemory.entities[0].name, 'Sunken Archive')
  assert.equal(first.worldMemory.quests.find((quest) => quest.id === 'quest:chapter:1').status, 'active')
  assert.deepEqual(second.worldMemory, first.worldMemory)
})

test('a confirmed scene transition closes the old quest and records the next chapter canon', () => {
  const initial = initialState()
  const result = advance(initial, 'completed')
  const sceneEvent = result.events.find((event) => event.event_type === 'SceneAdvanced')
  const facts = result.events.filter((event) => event.event_type === 'WorldFactRecorded')

  assert.ok(sceneEvent.event_id.startsWith('scene-event:'))
  assert.equal(result.state.worldMemory.quests.find((quest) => quest.id === 'quest:chapter:1').status, 'completed')
  assert.equal(result.state.worldMemory.quests.find((quest) => quest.id === 'quest:chapter:2').status, 'active')
  assert.equal(result.state.worldMemory.quests.find((quest) => quest.id === 'quest:chapter:2').objectives[0], 'Find Captain Vale')
  assert.ok(result.state.worldMemory.entities.some((entity) => entity.name === 'Moon Harbor'))
  assert.equal(facts.length, 2)
  assert.ok(facts.every((event) => event.payload.fact.source_event_ids.includes(sceneEvent.event_id)))
  assert.deepEqual(replayEvents(initial, result.events), result.state)
})

test('an unresolved scene objective remains active beside the next chapter quest', () => {
  const result = advance(initialState(), 'unresolved')
  const oldQuest = result.state.worldMemory.quests.find((quest) => quest.id === 'quest:chapter:1')
  const nextQuest = result.state.worldMemory.quests.find((quest) => quest.id === 'quest:chapter:2')

  assert.equal(oldQuest.status, 'active')
  assert.match(oldQuest.summary, /remains hidden/u)
  assert.equal(nextQuest.status, 'active')
  assert.ok(result.state.adventure.unresolvedThreads.includes('The seal opens the northern vault'))
})

test('the party can recall an automatically recorded arrival without an LLM', () => {
  const state = advance(initialState()).state
  const memory = worldMemoryForViewer(state.worldMemory, { playerId: 'hero', isPartyMember: true })
  const answer = answerKnownLore('\u0447\u0442\u043e \u044f \u0437\u043d\u0430\u044e \u043f\u0440\u043e Moon Harbor?', { ...state, worldMemory: memory })

  assert.equal(answer.provider, 'AgentWorldkeeper')
  assert.equal(answer.turn_consumed, false)
  assert.match(answer.narration, /lighthouse dark/u)
})

test('a new campaign contains canonical starting memory before persistence', async () => {
  const state = await new CampaignBootstrapper().create({
    code: 'MEMORY-BOOT',
    name: 'Memory Boot',
    partyName: 'Witnesses',
    world: { startingLocation: 'Ash Gate', openingSituation: 'A bell rings below the city.' },
    players: [{ id: 'hero', character: 'Ada', hp: 10, maxHp: 10, inventory: [] }],
  })

  assert.ok(state.worldMemory.entities.some((entity) => entity.name === state.scene.location))
  assert.equal(state.worldMemory.quests.find((quest) => quest.id === 'quest:chapter:1').status, 'active')
})

test('заголовок квеста главы не накапливает обёртку «Продолжить квест»', () => {
  // Цель сцены — призыв к действию, заголовок квеста — сама цель. Раньше заголовок
  // выводился из уже обёрнутой цели, и каждая глава добавляла ещё один слой.
  assert.equal(questTitleFromObjective('Найти караван'), 'Найти караван')
  assert.equal(questTitleFromObjective('Продолжить квест «Найти караван»'), 'Найти караван')
  assert.equal(
    questTitleFromObjective('Продолжить квест «Продолжить квест «Найти караван»»'),
    'Найти караван',
  )
  assert.equal(
    questTitleFromObjective('Развить последствия победы в квесте «Найти караван» и приблизить развязку'),
    'Найти караван',
  )
  assert.equal(
    questTitleFromObjective('Ответить на последствия провала квеста «Найти караван» и найти новый путь'),
    'Найти караван',
  )
})

test('квест главы выводится из обёрнутой цели без вложенности', () => {
  const state = normalizeCampaignState({
    sessionCode: 'QUEST-TITLE',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Ada', hp: 10, maxHp: 10, inventory: [] }],
    scene: {
      title: 'Развилка', location: 'Развилка',
      objective: 'Продолжить квест «Продолжить квест «Найти караван»»',
      turn: 1, cells: [{ x: 1, y: 1, type: 'floor', revealed: true }],
    },
    adventure: { chapter: 3, currentHook: '', unresolvedThreads: [], visitedLocations: [], history: [] },
  })

  const memory = ensureSceneWorldMemory(state.worldMemory, state)
  const quest = memory.quests.find((entry) => entry.id === 'quest:chapter:3')

  assert.equal(quest.title, 'Найти караван')
  assert.equal((quest.title.match(/Продолжить квест/gu) ?? []).length, 0)
})

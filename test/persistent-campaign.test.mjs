import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { campaignConceptForAgent } from '../server/agent-context.mjs'
import { AuthoritativeExecutor } from '../server/authoritative-executor.mjs'
import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import {
  campaignCanAdvanceArc,
  campaignCanAutoComplete,
} from '../server/campaign-lifecycle.mjs'
import { campaignModeFor, PERSISTENT_WORLD_OBJECTIVE } from '../server/campaign-stories.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommands, RulesEngine } from '../server/rules-engine.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { lifecycleEventForAction } from '../server/campaign-lifecycle.mjs'
import { buildCampaignArcPlan, MAX_CAMPAIGN_ARCS } from '../server/campaign-loop-policy.mjs'

const CAMPAIGN_ID = 'PERSISTENT-STORIES'
const LOCATION_ID = 'ford'
const THREAD_ID = 'thread:independent'

function diceService() {
  return new DiceService({
    rng: new SequenceDiceRng([]),
    idFactory: () => 'roll:persistent',
    now: () => '2026-09-15T12:00:00.000Z',
  })
}

function rulesEngine() {
  return new RulesEngine({ diceService: diceService() })
}

function mainQuest({ id = 'quest:main', title = 'Найти артефакт', status = 'active', triggered = false } = {}) {
  return {
    id,
    title,
    summary: 'Разобраться с артефактом в старом архиве.',
    status,
    visibility: 'party',
    entity_ids: [],
    objectives: ['Найти след артефакта'],
    clock: { current: triggered ? 2 : 0, max: 2, label: 'Улики' },
  }
}

function rawCampaign({ mode = 'persistent', quests = [mainQuest({ triggered: true })], sceneObjective = 'Найти артефакт', lifecycle = 'active', concept = {} } = {}) {
  return {
    sessionCode: CAMPAIGN_ID,
    campaign: 'Постоянные истории',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero', character: 'Ада', level: 3, hp: 24, maxHp: 24, armor: 14, speed: 30,
      abilities: { str: 14, dex: 14, con: 12, int: 12, wis: 12, cha: 10 },
      inventory: [{ id: 'item:torch', name: 'Факел', type: 'gear', quantity: 1 }],
      x: 0, y: 0,
    }],
    campaignConcept: { campaign_mode: mode, ...concept },
    scene: {
      title: 'Тихий Брод', location: 'Тихий Брод', location_id: LOCATION_ID,
      objective: sceneObjective, turn: 4,
      cells: [{ x: 0, y: 0, type: 'floor', revealed: true }],
    },
    adventure: {
      chapter: 4, currentHook: sceneObjective, visitedLocations: ['Тихий Брод'], history: [],
    },
    worldMap: {
      version: 1, seed: 'persistent-world-map', name: 'Постоянные земли', width: 1000, height: 640,
      currentLocationId: LOCATION_ID,
      regions: [{ id: 'region:ford', name: 'Долина', biome: 'plains', x: 500, y: 320, radius: 200 }],
      locations: [{ id: LOCATION_ID, name: 'Тихий Брод', kind: 'town', x: 500, y: 320, regionId: 'region:ford', known: true, visited: true }],
      routes: [],
    },
    worldMemory: {
      entities: [{ id: LOCATION_ID, kind: 'location', name: 'Тихий Брод', summary: 'Поселение у реки.', aliases: [], visibility: 'party', tags: [] }],
      facts: [], quests,
      threads: [{
        id: THREAD_ID, title: 'Независимая угроза', summary: 'Бандиты готовят налёт на дорогу.',
        status: 'active', visibility: 'party', entity_ids: [LOCATION_ID], quest_ids: [],
        clock: { current: 1, max: 4, label: 'Подготовка', triggered: false }, source_event_ids: [],
      }],
    },
    mechanics: {
      world_time: { elapsed_minutes: 180 },
      positions: { hero: { x: 0, y: 0 } },
      combat: { active: false }, encounter: null,
      campaign_lifecycle: { status: lifecycle },
    },
    suggestions: ['Старая подсказка'],
  }
}

function persistentCampaign(options = {}) {
  return normalizeCampaignState(rawCampaign(options))
}

function resolveQuestCommand({ id = 'quest:main', commandId = 'resolve:main', outcome = 'success' } = {}) {
  return {
    command_type: 'ResolveQuest', command_id: commandId, quest_id: id, outcome,
    summary: outcome === 'success' ? 'Отряд нашёл артефакт.' : 'Отряд отказался от прежней цели.',
    next_objective: PERSISTENT_WORLD_OBJECTIVE, source_event_ids: [],
  }
}

function abandonInteraction(questId = 'quest:main') {
  return {
    id: 'decision:abandon-main', type: 'vote', title: 'Отказаться от задания?',
    description: 'Отряд остаётся в текущей локации.',
    options: [{ id: 'keep', label: 'Продолжить задание' }, { id: 'abandon', label: 'Отказаться от задания' }],
    votes: { hero: 'abandon' }, status: 'resolved', resolvedOptionId: 'abandon',
    eligibleActorIds: ['hero'], eligibleVoterIds: ['hero'], activeVoterIds: ['hero'], requiredVotes: 1,
    voterByActorId: { hero: 'hero' }, abstainedVoterIds: [], abstentions: {},
    questAbandonment: { schemaVersion: 1, questId },
  }
}

function resolvePlan(state, commands, context = { isDirector: true }) {
  return resolveCommands(commands, state, { diceService: diceService(), context })
}

function stableWorldMap(map) {
  return {
    seed: map?.seed,
    currentLocationId: map?.currentLocationId,
    regions: map?.regions,
    locations: (map?.locations ?? []).map((location) => ({
      id: location.id, name: location.name, kind: location.kind,
      x: location.x, y: location.y, regionId: location.regionId,
    })),
    routes: map?.routes,
  }
}

class FailAfterCommitStore {
  constructor(delegate) {
    this.delegate = delegate
    this.failNext = true
  }

  async load(...args) { return this.delegate.load(...args) }
  async getByIdempotencyKey(...args) { return this.delegate.getByIdempotencyKey(...args) }

  async commit(request) {
    const committed = await this.delegate.commit(request)
    if (this.failNext) {
      this.failNext = false
      throw new Error('injected failure after commit')
    }
    return committed
  }
}

test('persistent ResolveQuest records story completion without ending or resetting the campaign', () => {
  const initial = persistentCampaign()
  const before = structuredClone(initial)
  const resolved = resolvePlan(initial, [resolveQuestCommand()])
  const after = resolved.state
  const types = resolved.events.map((event) => event.event_type)
  const storyEvent = resolved.events.find((event) => event.event_type === 'CampaignStoryCompleted')

  assert.equal(campaignModeFor(after), 'persistent')
  assert.equal(types.filter((type) => type === 'CampaignStoryCompleted').length, 1)
  assert.equal(types.includes('CampaignCompleted'), false)
  assert.equal(types.includes('CampaignArcCompleted'), false)
  assert.equal(after.mechanics.campaign_lifecycle.status, 'active')
  assert.equal(after.worldMemory.quests.find((quest) => quest.id === 'quest:main').status, 'completed')
  assert.equal(after.campaignConcept.story_sequence, 1)
  assert.equal(after.campaignConcept.story_history.length, 1)
  assert.match(after.campaignConcept.story_history[0].story_id, /^story:[a-f0-9]{16}:1$/u)
  assert.equal(storyEvent.payload.schema_version, 1)
  assert.equal(storyEvent.payload.story_number, 1)
  assert.equal(storyEvent.payload.quest_id, 'quest:main')
  assert.equal(storyEvent.payload.outcome, 'success')
  assert.equal(after.scene.location_id, before.scene.location_id)
  assert.equal(after.scene.turn, before.scene.turn)
  assert.equal(after.adventure.chapter, before.adventure.chapter)
  assert.deepEqual(stableWorldMap(after.worldMap), stableWorldMap(before.worldMap))
  assert.deepEqual(after.worldMemory.threads, before.worldMemory.threads)
  assert.equal(after.scene.objective, PERSISTENT_WORLD_OBJECTIVE)
  assert.equal(after.adventure.currentHook, PERSISTENT_WORLD_OBJECTIVE)
  assert.deepEqual(after.suggestions, [])
  assert.equal(campaignCanAutoComplete(after), false)
})

test('persistent ResolveQuestDecision отказа остаётся в сцене и завершает только выбранную историю', () => {
  const initial = persistentCampaign({ sceneObjective: 'Найти артефакт' })
  initial.agentInteraction = abandonInteraction()
  const before = structuredClone(initial)
  const resolved = resolvePlan(initial, [{
    command_type: 'ResolveQuestDecision', command_id: 'resolve:abandon-main',
    interaction_id: 'decision:abandon-main', house_rule_id: 'skazanie:quest-decision:v1',
  }])
  const after = resolved.state
  const types = resolved.events.map((event) => event.event_type)
  const questEvent = resolved.events.find((event) => event.event_type === 'QuestResolved')
  const storyEvent = resolved.events.find((event) => event.event_type === 'CampaignStoryCompleted')

  assert.ok(questEvent)
  assert.ok(storyEvent)
  assert.equal(questEvent.payload.outcome, 'abandoned')
  assert.equal(questEvent.payload.stay_in_location, true)
  assert.equal(questEvent.payload.event_schema_version, 2)
  assert.equal(after.worldMemory.quests.find((quest) => quest.id === 'quest:main').status, 'abandoned')
  assert.equal(after.worldMemory.quests.find((quest) => quest.id === 'quest:main').stay_in_location, true)
  assert.equal(after.campaignConcept.story_sequence, 1)
  assert.equal(storyEvent.payload.outcome, 'abandoned')
  assert.equal(types.includes('PartyDecisionConsumed'), true)
  assert.equal(types.includes('SceneAdvanced'), false)
  assert.equal(types.includes('CampaignCompleted'), false)
  assert.equal(types.includes('CampaignArcCompleted'), false)
  assert.equal(after.agentInteraction, null)
  assert.equal(after.scene.location_id, before.scene.location_id)
  assert.equal(after.scene.turn, before.scene.turn)
  assert.equal(after.adventure.chapter, before.adventure.chapter)
  assert.deepEqual(stableWorldMap(after.worldMap), stableWorldMap(before.worldMap))
  assert.deepEqual(after.worldMemory.threads, before.worldMemory.threads)
  assert.equal(after.scene.objective, PERSISTENT_WORLD_OBJECTIVE)
  assert.equal(after.adventure.currentHook, PERSISTENT_WORLD_OBJECTIVE)
  assert.equal(after.mechanics.campaign_lifecycle.status, 'active')
  assert.equal(campaignCanAutoComplete(after), false)

  const next = resolvePlan(after, [{
    command_type: 'UpdateObjective', command_id: 'objective:after-abandon', objective: 'Осмотреть старую пристань',
  }])
  assert.equal(next.state.scene.objective, 'Осмотреть старую пристань')
  assert.equal(next.state.mechanics.campaign_lifecycle.status, 'active')
  assert.equal(next.events.some((event) => event.event_type === 'CampaignCompleted'), false)
})

test('persistent story history keeps 13 completed stories while the agent brief stays bounded', () => {
  const initial = persistentCampaign()
  let state = initial
  const events = []

  for (let number = 1; number <= 13; number += 1) {
    if (number > 1) {
      const added = resolvePlan(state, [{
        command_type: 'UpsertQuest', command_id: `quest:add:${number}`,
        quest: mainQuest({ id: `quest:story:${number}`, title: `История ${number}`, triggered: true }),
      }])
      state = added.state
      events.push(...added.events)
    }
    const resolved = resolvePlan(state, [resolveQuestCommand({
      id: number === 1 ? 'quest:main' : `quest:story:${number}`,
      commandId: `story:resolve:${number}`,
    })])
    state = resolved.state
    events.push(...resolved.events)
    const story = resolved.events.find((event) => event.event_type === 'CampaignStoryCompleted')
    assert.equal(story?.payload.story_number, number)
  }

  const history = state.campaignConcept.story_history
  assert.equal(campaignModeFor(state), 'persistent')
  assert.equal(state.campaignConcept.arc, undefined)
  assert.equal(state.campaignConcept.story_sequence, 13)
  assert.equal(history.length, 13)
  assert.deepEqual(history.map((story) => story.story_number), Array.from({ length: 13 }, (_, index) => index + 1))
  assert.equal(new Set(history.map((story) => story.story_id)).size, 13)
  assert.equal(state.worldMemory.threads.find((thread) => thread.id === THREAD_ID).status, 'active')
  assert.equal(state.worldMemory.quests.some((quest) => quest.id.startsWith('quest:chapter:')), false)

  const brief = campaignConceptForAgent(state)
  assert.equal(brief.campaign_mode, 'persistent')
  assert.equal(brief.quests_optional, true)
  assert.equal(brief.completed_stories.length, 3)
  assert.deepEqual(brief.completed_stories.map((story) => story.story_id), history.slice(-3).map((story) => story.story_id))

  const replayed = replayEvents(initial, events)
  assert.deepEqual(replayed, state)
})

test('persistent mode does not synthesize chapter quests when a scene has no quest', () => {
  const initial = normalizeCampaignState(rawCampaign({ quests: [], sceneObjective: '', concept: { campaign_mode: 'persistent' } }))
  initial.agentInteraction = {
    id: 'decision:persistent-scene', type: 'vote', title: 'Перейти', description: 'Переход подтверждён.',
    options: [{ id: 'continue', label: 'Перейти' }], status: 'resolved', resolvedOptionId: 'continue',
    eligibleActorIds: [], eligibleVoterIds: [], activeVoterIds: [], requiredVotes: 0,
    votes: {}, voterByActorId: {}, abstainedVoterIds: [], abstentions: {},
  }
  assert.equal(initial.worldMemory.quests.length, 0)

  const transitioned = resolvePlan(initial, [{
    command_type: 'AdvanceScene', command_id: 'persistent:scene:advance',
    party_decision: { interaction_id: 'decision:persistent-scene', resolved_option_id: 'continue' },
    scene_args: {
      title: 'Новая пристань', location: 'Новая пристань', objective: 'Осмотреться',
      transition: 'Отряд переходит к новой пристани.', arrival: 'Перед отрядом открывается новая пристань.',
    },
  }])

  assert.equal(transitioned.events.some((event) => event.event_type === 'SceneAdvanced'), true)
  assert.equal(transitioned.events.some((event) => event.event_type === 'QuestUpserted'), false)
  assert.equal(transitioned.state.worldMemory.quests.some((quest) => quest.id.startsWith('quest:chapter:')), false)
  assert.equal(transitioned.state.campaignConcept.story_sequence ?? 0, 0)
})

test('adventure mode retains the 12-arc limit and does not emit persistent story events', () => {
  const adventure = normalizeCampaignState(rawCampaign({ mode: 'adventure', quests: [mainQuest({ triggered: true })] }))
  const resolved = resolvePlan(adventure, [resolveQuestCommand()])
  assert.equal(campaignModeFor(resolved.state), 'adventure')
  assert.equal(resolved.events.some((event) => event.event_type === 'CampaignStoryCompleted'), false)

  const arc = buildCampaignArcPlan('adventure-limit', MAX_CAMPAIGN_ARCS)
  const final = normalizeCampaignState({
    ...rawCampaign({ mode: 'adventure', quests: [mainQuest({ status: 'completed', triggered: true })], concept: { arc } }),
    adventure: { chapter: arc.target_scenes, currentHook: 'Финал', visitedLocations: ['Тихий Брод'], history: [] },
    autonomy: { pacing: { beat: 8, phase: 'climax', tension: 90 }, encounter_outcomes: [{ encounter_id: 'final-encounter' }] },
    mechanics: {
      world_time: { elapsed_minutes: 600 }, positions: { hero: { x: 0, y: 0 } }, combat: { active: false },
      encounter: { id: 'final-encounter', status: 'ended', difficulty: 'hard', created_in_chapter: arc.target_scenes },
      campaign_lifecycle: { status: 'active' },
    },
  })
  assert.equal(campaignCanAutoComplete(final), true)
  assert.equal(campaignCanAdvanceArc(final), false)
})

test('persistent campaign keeps manual lifecycle controls and terminal restrictions', () => {
  const initial = persistentCampaign()
  const manual = lifecycleEventForAction('complete', initial, { actorId: 'owner' })
  const completed = applyGameEvent(initial, manual)
  assert.equal(completed.mechanics.campaign_lifecycle.status, 'completed')

  assert.throws(
    () => resolvePlan(completed, [{ command_type: 'UpdateObjective', command_id: 'terminal:objective', objective: 'После финала' }]),
    (error) => error?.code === 'CAMPAIGN_READ_ONLY',
  )
})

test('persistent story commit survives a failure after commit and idempotent retry', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-persistent-story-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const store = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState, snapshotEvery: 2 })
  const initial = persistentCampaign()
  await store.initializeCampaign({ campaign_id: CAMPAIGN_ID, initial_state: initial })

  const key = 'persistent-story:once'
  const command = resolveQuestCommand({ commandId: 'story:resolve:once' })
  const flaky = new FailAfterCommitStore(store)
  const firstExecutor = new AuthoritativeExecutor({ eventStore: flaky, rulesEngine: rulesEngine() })
  await assert.rejects(
    firstExecutor.executeCommands({ campaignId: CAMPAIGN_ID, idempotencyKey: key, commands: [command], context: { isDirector: true } }),
    /injected failure after commit/u,
  )

  const committed = await store.load(CAMPAIGN_ID)
  assert.equal(committed.state.campaignConcept.story_sequence, 1)
  assert.equal((await store.getEvents(CAMPAIGN_ID)).filter((event) => event.event_type === 'CampaignStoryCompleted').length, 1)

  const reopened = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState, snapshotEvery: 2 })
  const retryExecutor = new AuthoritativeExecutor({ eventStore: reopened, rulesEngine: rulesEngine() })
  const retry = await retryExecutor.executeCommands({ campaignId: CAMPAIGN_ID, idempotencyKey: key, commands: [command], context: { isDirector: true } })
  assert.equal(retry.replayed, true)
  assert.deepEqual(retry.state, committed.state)
  assert.deepEqual((await reopened.replay(CAMPAIGN_ID, { use_snapshots: false })).state, committed.state)
  assert.equal((await reopened.getEvents(CAMPAIGN_ID)).filter((event) => event.event_type === 'CampaignStoryCompleted').length, 1)
})

test('стороннее и скрытое задание не закрывают основную историю и не раскрываются в её архиве', () => {
  const main = mainQuest({ triggered: false })
  const side = mainQuest({ id: 'quest:side', title: 'Стороннее поручение', triggered: true })
  const secret = { ...mainQuest({ id: 'quest:secret', title: 'Скрытый план', triggered: true }), visibility: 'gm_only' }
  const initial = persistentCampaign({ quests: [secret, main, side] })
  const resolved = resolvePlan(initial, [resolveQuestCommand({ id: side.id }), resolveQuestCommand({ id: secret.id })])
  assert.ok(!resolved.events.some((event) => event.event_type === 'CampaignStoryCompleted'))
  assert.equal(resolved.state.campaignConcept.story_sequence ?? 0, 0)
  assert.deepEqual(resolved.state.campaignConcept.story_history ?? [], [])
  assert.equal(resolved.state.scene.objective, initial.scene.objective)
})

test('основная история связана по ID и не зависит от порядка поручений', () => {
  const initial = persistentCampaign()
  assert.equal(initial.campaignConcept.story_quest_id, 'quest:main')
  initial.worldMemory.quests.unshift(mainQuest({ id: 'quest:earlier-side', title: 'Побочное поручение', triggered: true }))
  const side = resolvePlan(initial, [resolveQuestCommand({ id: 'quest:earlier-side' })])
  assert.ok(!side.events.some((event) => event.event_type === 'CampaignStoryCompleted'))
  assert.equal(side.state.campaignConcept.story_quest_id, 'quest:main')
  const main = resolvePlan(side.state, [resolveQuestCommand()])
  assert.equal(main.events.find((event) => event.event_type === 'CampaignStoryCompleted').payload.quest_id, 'quest:main')
  assert.equal(main.state.campaignConcept.story_quest_id, null)
})

test('автономный шаг закрывает историю при отключённом рассказчике и не назначает новое задание', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-persistent-director-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const store = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await store.initializeCampaign({ campaign_id: CAMPAIGN_ID, initial_state: persistentCampaign() })
  let calls = 0
  const autonomy = new AutonomousCampaignOrchestrator({ eventStore: store, rulesEngine: rulesEngine(),
    narrator: { render: async () => { calls += 1; throw new Error('LLM отключена') } } })
  const request = { campaignId: CAMPAIGN_ID, idempotencyKey: 'persistent-director-step',
    intent: { type: 'offer_next_hook', hook: 'Осмотреть текущую локацию' } }
  const result = await autonomy.runIntent(request)
  assert.equal(calls, 0)
  assert.equal(result.state.campaignConcept.story_sequence, 1)
  assert.equal(result.state.mechanics.campaign_lifecycle.status, 'active')
  assert.equal(result.state.worldMemory.quests.filter((quest) => quest.status === 'active').length, 0)
  assert.equal(result.state.scene.objective, PERSISTENT_WORLD_OBJECTIVE)
  const eventCount = (await store.getEvents(CAMPAIGN_ID)).length
  await autonomy.runIntent(request)
  assert.equal((await store.getEvents(CAMPAIGN_ID)).length, eventCount)
  assert.equal(calls, 0)
  const continued = await autonomy.runIntent({ campaignId: CAMPAIGN_ID, idempotencyKey: 'player-next-step', intent: { type: 'continue_exploration' } })
  assert.equal(continued.state.campaignConcept.story_sequence, 1)
  assert.equal(continued.state.worldMemory.quests.filter((quest) => quest.status === 'active').length, 0)
})

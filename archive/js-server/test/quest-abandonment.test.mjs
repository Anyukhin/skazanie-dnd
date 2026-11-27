import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AuthoritativeExecutor, PARTY_DECISION_CAPABILITY } from '../server/authoritative-executor.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { resolvePartyVote } from '../server/party-decision.mjs'
import { requestQuestDecision as requestQuestAbandonment, finishQuestDecision as finishQuestAbandonment } from '../server/quest-decisions.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

const campaignId = 'QUEST-CHOICE'
function state() {
  return normalizeCampaignState({
    sessionCode: campaignId, partyMemberIds: ['hero-a', 'hero-b'],
    players: ['hero-a', 'hero-b'].map((id, index) => ({ id, character: id, hp: 10, maxHp: 10, x: index, y: 0 })),
    scene: { location: 'Тихий Брод', location_id: 'ford', turn: 4, objective: 'Найти печать',
      cells: [{ x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'floor', revealed: true }] },
    adventure: { chapter: 1, currentHook: 'Найти печать', visitedLocations: ['Тихий Брод'] },
    worldMemory: { quests: [
      { id: 'quest:first', title: 'Спасти купца', status: 'active', visibility: 'party' },
      { id: 'quest:second', title: 'Найти печать', status: 'active', visibility: 'party' },
      { id: 'quest:secret', title: 'СЕКРЕТ', status: 'active', visibility: 'gm_only' },
    ] },
  })
}

async function setup(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-quest-decision-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const store = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await store.initializeCampaign({ campaignId, initialState: state() })
  const rulesEngine = new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([]) }) })
  const executor = new AuthoritativeExecutor({ eventStore: store, rulesEngine })
  const request = (overrides = {}) => requestQuestAbandonment({
    executor, campaignId, actorId: 'hero-a', questId: 'quest:second', idempotencyKey: 'open-second',
    voterSnapshot: () => ({ eligibleHeroIds: ['hero-a', 'hero-b'] }), ...overrides,
  })
  const vote = async (actorId, interactionId, optionId = 'abandon') => executor.commitDerived({
    campaignId, idempotencyKey: `vote:${actorId}:${interactionId}`, producerCapability: PARTY_DECISION_CAPABILITY,
    deriveEvents: (current) => resolvePartyVote(current, { heroId: actorId, interactionId, optionId }).events,
  })
  return { store, executor, request, vote, rulesEngine, rootDir }
}

test('отказ выбирает второй квест по ID, ждёт группу и переживает повтор/replay/restart без перехода', async (t) => {
  const { store, executor, request, vote, rootDir } = await setup(t)
  const before = (await store.load(campaignId)).state
  const opened = await request()
  const interactionId = opened.events[0].payload.interaction.id
  const duplicate = await request()
  assert.equal(duplicate.commit_id, opened.commit_id)
  await assert.rejects(request({ questId: 'quest:first' }), { code: 'IDEMPOTENCY_CONFLICT' })
  await vote('hero-a', interactionId)
  assert.equal(await finishQuestAbandonment({ executor, campaignId }), null)
  await vote('hero-b', interactionId)
  const [resolved] = await Promise.all([
    finishQuestAbandonment({ executor, campaignId }), finishQuestAbandonment({ executor, campaignId }),
  ])
  assert.equal(resolved.events.filter((event) => event.event_type === 'QuestResolved').length, 1)
  const after = (await store.load(campaignId)).state
  assert.equal(after.worldMemory.quests.find((quest) => quest.id === 'quest:first').status, 'active')
  assert.equal(after.worldMemory.quests.find((quest) => quest.id === 'quest:second').status, 'abandoned')
  assert.equal(after.agentInteraction, null)
  assert.equal(after.scene.location_id, before.scene.location_id)
  assert.equal(after.scene.turn, before.scene.turn)
  assert.deepEqual(after.mechanics.positions, before.mechanics.positions)
  assert.deepEqual(after.mechanics.world_time, before.mechanics.world_time)
  assert.equal(after.adventure.chapter, before.adventure.chapter)
  assert.doesNotMatch(after.adventure.currentHook, /печать/u)
  const sceneQuest = after.worldMemory.quests.find((quest) => quest.id === 'quest:chapter:1')
  assert.doesNotMatch(sceneQuest.title, /печать/u)
  assert.equal(after.worldMemory.quests.find((quest) => quest.id === 'quest:second').stay_in_location, true)
  assert.equal(after.mechanics.campaign_lifecycle.status, 'active')
  const restarted = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  assert.deepEqual((await restarted.load(campaignId, { useSnapshots: false })).state, after)
  assert.equal(await finishQuestAbandonment({ executor, campaignId }), null)
})

test('неизвестное и скрытое задание не раскрываются; чужой герой и незавершённое решение не исполняются', async (t) => {
  const { request, rulesEngine, store } = await setup(t)
  for (const questId of ['quest:secret', 'quest:missing']) {
    await assert.rejects(request({ questId }), { code: 'WORLD_QUEST_NOT_FOUND' })
  }
  await assert.rejects(request({ actorId: 'outsider' }), { code: 'ACTOR_FORBIDDEN' })
  const opened = await request()
  const current = (await store.load(campaignId)).state
  const command = { command_type: 'ResolveQuestDecision', interaction_id: opened.events[0].payload.interaction.id,
    house_rule_id: 'skazanie:quest-decision:v1' }
  assert.throws(() => rulesEngine.resolve(command, current, {}), { code: 'QUEST_DECISION_FORBIDDEN' })
  assert.throws(() => rulesEngine.resolve(command, current, { isDirector: true }), { code: 'PARTY_DECISION_REQUIRED' })
})

test('решение продолжить задание очищает голосование и не закрывает квест', async (t) => {
  const { executor, store, request, vote } = await setup(t)
  const opened = await request()
  const interactionId = opened.events[0].payload.interaction.id
  await vote('hero-a', interactionId, 'keep')
  await vote('hero-b', interactionId, 'keep')
  const result = await finishQuestAbandonment({ executor, campaignId })
  assert.deepEqual(result.events.map((event) => event.event_type), ['PartyDecisionConsumed'])
  assert.equal((await store.load(campaignId)).state.worldMemory.quests[1].status, 'active')
})

test('отказ от стороннего поручения сохраняет текущую цель и служебное задание сцены', async (t) => {
  const { executor, store, request, vote } = await setup(t)
  const before = (await store.load(campaignId)).state
  const opened = await request({ questId: 'quest:first' })
  const interactionId = opened.events[0].payload.interaction.id
  await vote('hero-a', interactionId)
  await vote('hero-b', interactionId)
  await finishQuestAbandonment({ executor, campaignId })
  const after = (await store.load(campaignId)).state
  assert.equal(after.scene.objective, before.scene.objective)
  assert.equal(after.adventure.currentHook, before.adventure.currentHook)
  assert.deepEqual(after.worldMemory.quests.find((quest) => quest.id === 'quest:chapter:1'), before.worldMemory.quests.find((quest) => quest.id === 'quest:chapter:1'))
})

test('служебная цель не становится поручением для отказа, а закрывшееся во время голосования задание не переписывается', async (t) => {
  const { executor, store, request, vote } = await setup(t)
  await assert.rejects(request({ questId: 'quest:chapter:1' }), { code: 'WORLD_QUEST_NOT_ABANDONABLE' })
  const opened = await request()
  const interactionId = opened.events[0].payload.interaction.id
  const loaded = await store.load(campaignId)
  await store.commit({ campaign_id: campaignId, expected_state_version: loaded.state_version,
    idempotency_key: 'external-resolution', events: [{ event_type: 'QuestResolved', actor_id: null,
      payload: { quest_id: 'quest:second', outcome: 'success', summary: 'Поручение уже выполнено.' }, visibility: 'party' }] })
  await vote('hero-a', interactionId)
  await vote('hero-b', interactionId)
  const result = await finishQuestAbandonment({ executor, campaignId })
  assert.deepEqual(result.events.map((event) => event.event_type), ['PartyDecisionConsumed'])
  assert.equal((await store.load(campaignId)).state.worldMemory.quests[1].status, 'completed')
})

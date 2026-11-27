import assert from 'node:assert/strict'
import test from 'node:test'
import { palaceFixture } from './shared-npc-consequence-fixture.mjs'
import { applyGameEvent, replayEvents } from '../server/rules-engine.mjs'
import { planQuestConsequenceDrafts } from '../server/quest-consequences.mjs'
import { campaignStoryCompletionDraft, campaignStoryChronicleEntry } from '../server/campaign-stories.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'
import { applyWorldMemoryEvent, worldMemoryForViewer } from '../server/world-memory.mjs'

async function concealedDeath() {
  const { state, heroId, kingId } = await palaceFixture()
  const quest = state.worldMemory.quests.find((entry) => entry.responsibility?.type === 'npc')
  state.campaignConcept.story_quest_id = quest.id
  state.scene.objective = quest.title
  state.adventure.currentHook = quest.title
  const events = [
    { event_type: 'NpcDied', event_id: 'hidden-death', visibility: 'gm_only', payload: { npc_id: kingId } },
    { event_type: 'WorldFactRecorded', event_id: 'hidden-death-fact', visibility: 'gm_only', payload: { fact: {
      id: 'fact:hidden-death', subject_id: kingId, predicate: 'died', object: 'дворец', summary: 'Король погиб тайно',
      visibility: 'gm_only', status: 'active', source_event_ids: ['hidden-death'],
    } } },
  ]
  let after = replayEvents(state, events)
  const consequences = planQuestConsequenceDrafts(after, events, { primaryQuestId: quest.id })
    .map((event, index) => ({ ...event, event_id: `hidden-consequence-${index}` }))
  events.push(...consequences)
  const story = campaignStoryCompletionDraft(state, events)
  assert.ok(story)
  events.push({ ...story, event_id: 'hidden-story' })
  after = replayEvents(state, events)
  after.messages = [campaignStoryChronicleEntry(events.at(-1))].filter(Boolean)
  return { state, after, events, heroId, quest }
}

test('тайная смерть закрывает задачу и историю внутри сервера, сохраняя последнее известное героям представление', async () => {
  const { state, after, events, heroId, quest } = await concealedDeath()
  assert.equal(after.worldMemory.quests.find((entry) => entry.id === quest.id).status, 'failed')
  assert.equal(after.campaignConcept.story_sequence, state.campaignConcept.story_sequence + 1)
  const visible = campaignStateForViewer(after, { role: 'player' }, heroId)
  assert.equal(visible.worldMemory.quests.find((entry) => entry.id === quest.id).status, quest.status)
  assert.equal(visible.campaignConcept.story_sequence, state.campaignConcept.story_sequence)
  assert.equal(visible.campaignConcept.story_quest_id, quest.id)
  assert.equal(visible.scene.objective, state.scene.objective)
  assert.equal(visible.adventure.currentHook, state.adventure.currentHook)
  assert.equal(visible.messages.length, 0)
  assert.deepEqual(mechanicsForViewer(events.filter((event) => ['QuestInvalidated', 'CampaignStoryCompleted'].includes(event.event_type)), { role: 'player' }, heroId, after), [])
})

test('раскрытие факта обновляет задачу и историю одного героя без повторного последствия', async () => {
  const { after, heroId, quest } = await concealedDeath()
  const disclosed = applyGameEvent(after, { event_type: 'KnowledgeRevealed', event_id: 'learn-death', target_ids: [heroId],
    visibility: 'specific_player', payload: { fact_id: 'fact:hidden-death' } })
  const informed = campaignStateForViewer(disclosed, { role: 'player' }, heroId)
  const uninformed = campaignStateForViewer(disclosed, { role: 'player' }, 'another-hero')
  assert.equal(informed.worldMemory.quests.find((entry) => entry.id === quest.id).status, 'failed')
  assert.equal(uninformed.worldMemory.quests.find((entry) => entry.id === quest.id).status, quest.status)
  assert.equal(informed.campaignConcept.story_history.length, uninformed.campaignConcept.story_history.length + 1)
  assert.equal(disclosed.campaignConcept.story_sequence, after.campaignConcept.story_sequence)
  assert.doesNotMatch(JSON.stringify(uninformed), /Король погиб тайно|knowledge_history|hidden-consequence/u)
})

test('публичный шум со ссылкой на скрытое событие не раскрывает смерть и исход задания', async () => {
  const { after, heroId, quest } = await concealedDeath()
  const changed = applyGameEvent(after, { event_type: 'WorldFactRecorded', event_id: 'heard-noise', visibility: 'party', payload: { fact: {
    id: 'fact:noise', subject_id: quest.responsibility.npc_id, predicate: 'noise', object: 'шум во дворце',
    summary: 'Во дворце слышали шум.', status: 'active', visibility: 'party', source_event_ids: ['hidden-death'],
  } } })
  assert.equal(campaignStateForViewer(changed, { role: 'player' }, heroId).worldMemory.quests.find((entry) => entry.id === quest.id).status, quest.status)
})

test('позднейший известный итог не возвращает старую скрытую историю и не раскрывает её номер', async () => {
  const { after, heroId } = await concealedDeath()
  const publicStory = { event_type: 'CampaignStoryCompleted', visibility: 'party', payload: {
    schema_version: 1, story_id: 'another-story', story_number: 2, quest_id: 'another-quest', title: 'Новый путь',
    outcome: 'success', summary: 'Путь пройден.',
  } }
  const latest = applyGameEvent(after, publicStory)
  const view = campaignStateForViewer(latest, { role: 'player' }, heroId)
  assert.equal(view.campaignConcept.story_quest_id, null)
  assert.equal(view.campaignConcept.story_sequence, 1)
  assert.equal(view.campaignConcept.story_history[0].story_number, 1)
  assert.equal(mechanicsForViewer([publicStory], { role: 'player' }, heroId, latest)[0].payload.story_number, 1)
})

test('скрытая смена получателя не откатывает последующий известный прогресс и завершение', async () => {
  const { state, heroId } = await palaceFixture()
  const quest = state.worldMemory.quests.find((entry) => entry.responsibility?.type === 'office')
  let memory = applyWorldMemoryEvent(state.worldMemory, { event_type: 'QuestAssignmentChanged', event_id: 'secret-assignment', visibility: 'party', payload: {
    schema_version: 2, quest_id: quest.id, giver_npc_id: 'secret-recipient', knowledge_gate: { visibility: 'gm_only', fact_ids: [], source_event_ids: [] },
  } })
  memory = applyWorldMemoryEvent(memory, { event_type: 'QuestClockAdvanced', event_id: 'public-progress', visibility: 'party', payload: { quest_id: quest.id, amount: 1 } })
  const clock = memory.quests.find((entry) => entry.id === quest.id).clock
  const view = () => worldMemoryForViewer(memory, { playerId: heroId, isPartyMember: true }).quests.find((entry) => entry.id === quest.id)
  assert.deepEqual(view().clock, clock)
  memory = applyWorldMemoryEvent(memory, { event_type: 'QuestResolved', event_id: 'public-resolution', visibility: 'party', payload: { quest_id: quest.id, outcome: 'success', summary: 'Поручение исполнено.' } })
  assert.equal(view().status, 'completed')
  assert.equal(view().summary, 'Поручение исполнено.')
  assert.equal(view().giver_npc_id, quest.giver_npc_id)
})

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { confirmedQuestProgress, questProgressEvidenceFor } from '../server/campaign-loop-policy.mjs'
import { applyGameEvent, normalizeCampaignState, RulesEngine } from '../server/rules-engine.mjs'

const CAMPAIGN = 'N19-REAL'

function cells(width = 5, height = 3) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    revealed: true,
  }))
}

function quest(id = 'quest-supplies', entityId = 'supplies', current = 0, max = 3) {
  return {
    id,
    title: id === 'quest-supplies' ? 'Найти припасы' : 'Проверить стороннюю улику',
    summary: '',
    status: 'active',
    visibility: 'party',
    entity_ids: [entityId],
    objectives: [id === 'quest-supplies' ? 'Найти припасы' : 'Проверить улику'],
    clock: { current, max, label: 'Прогресс расследования', triggered: current >= max },
  }
}

function baseState({ campaignId = CAMPAIGN, current = 0, max = 3, facts = [], quests = null } = {}) {
  return normalizeCampaignState({
    sessionCode: campaignId,
    ruleset_id: 'srd_5_2_1',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero', character: 'Астер', characterClass: 'fighter', level: 1,
      hp: 20, maxHp: 20, armor: 16, speed: 30, proficiency: 2,
      abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 12, cha: 10 },
      inventory: [], x: 0, y: 0,
    }],
    enemies: [],
    scene: { title: 'Старая дорога', location: 'Старая дорога', objective: 'Найти припасы', cells: cells() },
    mechanics: {
      positions: { hero: { x: 0, y: 0 } },
      combat: { active: false, round: 0, active_index: 0, initiative: [], action_economy: {} },
      world_time: { elapsed_minutes: 0 },
    },
    worldMemory: {
      entities: [
        { id: 'supplies', kind: 'object', name: 'Пропавшие припасы', summary: '', aliases: [], visibility: 'party', tags: [] },
        { id: 'side-clue', kind: 'object', name: 'Сторонняя улика', summary: '', aliases: [], visibility: 'party', tags: [] },
      ],
      facts,
      quests: quests ?? [quest('quest-supplies', 'supplies', current, max)],
      knowledge: {},
    },
    autonomy: { pacing: { phase: 'development', tension: 40 }, director_history: [], director_outcomes: [] },
  })
}

async function fixture(t, initialState = baseState()) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-n19-real-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: initialState.sessionCode, initial_state: initialState })
  let rollId = 0
  const rulesEngine = new RulesEngine({
    diceService: new DiceService({
      rng: new SequenceDiceRng(Array(128).fill(4)),
      idFactory: () => `n19-roll-${++rollId}`,
    }),
  })
  const autonomy = new AutonomousCampaignOrchestrator({ eventStore, rulesEngine, now: () => 1_790_000_000_000 })
  return { eventStore, autonomy }
}

async function recordRealFact(autonomy, campaignId, {
  id, subjectId = 'supplies', predicate = 'discovery', summary = 'Отряд нашёл подтверждённую улику.', sourceEventIds = null,
} = {}) {
  let sourceIds = sourceEventIds
  if (sourceIds == null) {
    const source = await autonomy.runCommands(campaignId, `${id}:source`, [{
      command_type: 'DeclareAction', actor_id: 'hero', action: `Исследую улику ${id}`,
    }])
    sourceIds = [source.events.find((event) => event.event_type === 'ActionDeclared')?.event_id].filter(Boolean)
  }
  return autonomy.runCommands(campaignId, `${id}:fact`, [{
    command_type: 'RecordWorldFact',
    fact: {
      id, subject_id: subjectId, predicate, summary, visibility: 'party', source_event_ids: sourceIds,
    },
  }])
}

async function advance(autonomy, campaignId, key = 'advance-quest', questId = 'quest-supplies') {
  return autonomy.runIntent({
    campaignId,
    intent: { type: 'advance_quest_clock', quest_id: questId },
    idempotencyKey: key,
  })
}

test('pressure 2/3 plus fresh real discovery advances and resolves the quest', async (t) => {
  const { eventStore, autonomy } = await fixture(t, baseState({ current: 2 }))
  await recordRealFact(autonomy, CAMPAIGN, { id: 'fact-supplies-found' })

  const result = await advance(autonomy, CAMPAIGN, 'n19-real-progress')
  const events = await eventStore.getEvents(CAMPAIGN)
  const clock = events.find((event) => event.event_type === 'QuestClockAdvanced')
  const resolved = events.find((event) => event.event_type === 'QuestResolved')
  const intent = events.find((event) => event.event_type === 'DirectorIntentRecorded')

  assert.equal(result.state.worldMemory.quests[0].status, 'completed')
  assert.equal(clock.payload.schema_version, 2)
  assert.deepEqual(clock.payload.proof_fact_ids, ['fact-supplies-found'])
  assert.deepEqual(intent.payload.proof_fact_ids, ['fact-supplies-found'])
  assert.ok(resolved)
  assert.ok(resolved.payload.source_event_ids.includes(clock.event_id))
  assert.ok(result.state.worldMemory.quests[0].progress_fact_ids.includes('fact-supplies-found'))
})

test('3/3 pressure without proof cannot resolve or advance the quest', async (t) => {
  const { eventStore, autonomy } = await fixture(t, baseState({ current: 3, max: 3 }))
  const result = await advance(autonomy, CAMPAIGN, 'n19-pressure-only')

  const events = await eventStore.getEvents(CAMPAIGN)
  assert.equal(events.some((event) => event.event_type === 'QuestClockAdvanced'), false)
  assert.equal(events.some((event) => event.event_type === 'QuestResolved'), false)
  assert.notEqual(result.intent.type, 'advance_quest_clock')
  assert.equal((await eventStore.load(CAMPAIGN)).state.worldMemory.quests[0].status, 'active')
})

test('resolver ignores a forged QuestClockAdvanced source at pressure 3/3', async (t) => {
  const { eventStore, autonomy } = await fixture(t, baseState({ current: 3, max: 3 }))
  const result = await autonomy.resolveTriggeredQuests(CAMPAIGN, 'n19-forged-resolver', [{
    event_type: 'QuestClockAdvanced',
    event_id: 'forged-clock-event',
    payload: { quest_id: 'quest-supplies', amount: 1, proof_fact_ids: [] },
  }], { authorizedQuestIds: ['quest-supplies'] })

  assert.equal(result, null)
  assert.equal((await eventStore.getEvents(CAMPAIGN)).some((event) => event.event_type === 'QuestResolved'), false)
})

test('side quest evidence advances and resolves only the side quest', async (t) => {
  const { eventStore, autonomy } = await fixture(t, baseState({
    current: 3,
    quests: [quest('quest-supplies', 'supplies', 3), quest('quest-side', 'side-clue', 2)],
  }))
  await recordRealFact(autonomy, CAMPAIGN, { id: 'fact-side-clue', subjectId: 'side-clue', summary: 'Сторонняя улика подтверждена.' })
  const result = await advance(autonomy, CAMPAIGN, 'n19-side-only', 'quest-side')

  const state = (await eventStore.load(CAMPAIGN)).state
  assert.equal(result.intent.type, 'advance_quest_clock')
  assert.equal(state.worldMemory.quests.find((entry) => entry.id === 'quest-supplies').status, 'active')
  assert.equal(state.worldMemory.quests.find((entry) => entry.id === 'quest-side').status, 'completed')
  assert.deepEqual((await eventStore.getEvents(CAMPAIGN))
    .filter((event) => event.event_type === 'QuestResolved')
    .map((event) => event.payload.quest_id), ['quest-side'])
})

test('text-only, forged-source, forged-proof and consumed proof are rejected', async (t) => {
  const { eventStore, autonomy } = await fixture(t, baseState({ current: 0 }))
  await recordRealFact(autonomy, CAMPAIGN, {
    id: 'fact-text-only', subjectId: 'side-clue', summary: 'Найти припасы — чужая запись из другой сцены.',
  })
  const textOnly = await advance(autonomy, CAMPAIGN, 'n19-text-only')
  assert.notEqual(textOnly.intent.type, 'advance_quest_clock')
  assert.equal((await eventStore.load(CAMPAIGN)).state.worldMemory.quests[0].clock.current, 0)

  await recordRealFact(autonomy, CAMPAIGN, {
    id: 'fact-forged-source', sourceEventIds: ['event-does-not-exist'],
  })
  await recordRealFact(autonomy, CAMPAIGN, { id: 'fact-real-after-forged-source' })
  const afterForgedSource = await advance(autonomy, CAMPAIGN, 'n19-forged-source')
  assert.equal(afterForgedSource.intent.type, 'advance_quest_clock')
  assert.deepEqual(afterForgedSource.results.flatMap((result) => result.events ?? [])
    .filter((event) => event.event_type === 'QuestClockAdvanced')
    .at(-1)?.payload?.proof_fact_ids, ['fact-real-after-forged-source'])

  const forgedProof = autonomy.runCommands(CAMPAIGN, 'n19-forged-proof', [{
    command_type: 'AdvanceQuestClock', quest_id: 'quest-supplies', amount: 1, proof_fact_ids: ['fact-forged-id'],
  }])
  await assert.rejects(forgedProof)
  assert.equal((await eventStore.load(CAMPAIGN)).state.worldMemory.quests[0].clock.current, 1)

  const consumedFixture = await fixture(t, baseState({ campaignId: 'N19-CONSUMED', current: 0 }))
  await recordRealFact(consumedFixture.autonomy, 'N19-CONSUMED', { id: 'fact-real-once' })
  await advance(consumedFixture.autonomy, 'N19-CONSUMED', 'n19-consume-proof')
  const before = await consumedFixture.eventStore.load('N19-CONSUMED')
  const consumed = await advance(consumedFixture.autonomy, 'N19-CONSUMED', 'n19-consume-proof-again')
  const after = await consumedFixture.eventStore.load('N19-CONSUMED')
  assert.notEqual(consumed.intent.type, 'advance_quest_clock')
  assert.equal(after.state.worldMemory.quests[0].clock.current, before.state.worldMemory.quests[0].clock.current)
  assert.equal((await consumedFixture.eventStore.getEvents('N19-CONSUMED')).filter((event) => event.event_type === 'QuestClockAdvanced').length, 1)
})

test('proof, clock advance and completion are one-shot across retry and restart', async (t) => {
  const { eventStore, autonomy } = await fixture(t, baseState({ current: 2 }))
  await recordRealFact(autonomy, CAMPAIGN, { id: 'fact-retry-proof' })
  const first = await advance(autonomy, CAMPAIGN, 'n19-retry-key')
  const repeated = await advance(autonomy, CAMPAIGN, 'n19-retry-key')
  assert.equal(repeated.duplicate, true)
  assert.equal(repeated.state_version, first.state_version)

  const restartedStore = new FileEventStore({ rootDir: eventStore.rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  const restarted = new AutonomousCampaignOrchestrator({
    eventStore: restartedStore,
    rulesEngine: new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng(Array(32).fill(4)) }) }),
  })
  const afterRestart = await restarted.runIntent({
    campaignId: CAMPAIGN,
    intent: { type: 'advance_quest_clock', quest_id: 'quest-supplies' },
    idempotencyKey: 'n19-retry-key',
  })
  assert.equal(afterRestart.duplicate, true)
  const events = await restartedStore.getEvents(CAMPAIGN)
  assert.equal(events.filter((event) => event.event_type === 'QuestClockAdvanced').length, 1)
  assert.equal(events.filter((event) => event.event_type === 'QuestResolved').length, 1)
  assert.deepEqual((await restartedStore.replay(CAMPAIGN, { use_snapshots: false })).state, (await restartedStore.load(CAMPAIGN)).state)
})

test('retry after failure between DirectorIntentRecorded and commands keeps one proof and one completion', async (t) => {
  const { eventStore, autonomy } = await fixture(t, baseState({ current: 2 }))
  await recordRealFact(autonomy, CAMPAIGN, { id: 'fact-intent-retry' })
  const key = 'n19-intent-retry'
  const originalRunCommands = autonomy.runCommands.bind(autonomy)
  let failCommands = true
  autonomy.runCommands = async (campaignId, idempotencyKey, ...rest) => {
    if (failCommands && idempotencyKey === `${key}:commands`) {
      failCommands = false
      throw new Error('injected failure after DirectorIntentRecorded')
    }
    return originalRunCommands(campaignId, idempotencyKey, ...rest)
  }

  await assert.rejects(advance(autonomy, CAMPAIGN, key), /DirectorIntentRecorded/u)
  const interrupted = await eventStore.getEvents(CAMPAIGN)
  assert.equal(interrupted.filter((event) => event.event_type === 'DirectorIntentRecorded').length, 1)
  assert.equal(interrupted.some((event) => event.event_type === 'QuestClockAdvanced'), false)

  autonomy.runCommands = originalRunCommands
  const retry = await advance(autonomy, CAMPAIGN, key)
  assert.equal(retry.intent.type, 'advance_quest_clock')
  const events = await eventStore.getEvents(CAMPAIGN)
  assert.equal(events.filter((event) => event.event_type === 'DirectorIntentRecorded').length, 1)
  assert.equal(events.filter((event) => event.event_type === 'QuestClockAdvanced').length, 1)
  assert.equal(events.filter((event) => event.event_type === 'QuestResolved').length, 1)
})

test('unrelated completed encounter gives rewards but no quest progress or success', async (t) => {
  const statBlockId = 'srd_5_2_1:giant-rat'
  // После боя проходит автоматический восьмичасовой отдых; давление мира
  // может законно дойти только до max-1. Старт с 2/3 сохраняет часы этого
  // поручения неизменными и при этом проверяет настоящий путь восстановления.
  const initial = baseState({ campaignId: 'N19-FIGHT', current: 2 })
  initial.enemies = [{ id: 'rat-1', name: 'Крыса', hp: 0, maxHp: 7, alive: false, stat_block_id: statBlockId, provenance: { xp: 25 } }]
  initial.mechanics.positions['rat-1'] = { x: 2, y: 0 }
  initial.mechanics.encounter = {
    id: 'n19-unrelated-encounter', status: 'ended', outcome: 'enemies_defeated',
    difficulty: 'easy', theme: 'vermin', enemy_ids: ['rat-1'],
    enemies: [{ id: 'rat-1', stat_block_id: statBlockId }],
  }
  const { eventStore, autonomy } = await fixture(t, initial)
  const completion = await autonomy.completeEncounter({ campaignId: 'N19-FIGHT', outcome: 'enemies_defeated' })
  const state = (await eventStore.load('N19-FIGHT')).state
  const events = await eventStore.getEvents('N19-FIGHT')

  assert.ok(completion.reward)
  assert.ok(events.some((event) => event.event_type === 'ExperienceAwarded'))
  const questClockEvents = events.filter((event) => event.event_type === 'QuestClockAdvanced')
  const suppliesClockEvents = questClockEvents.filter((event) => event.payload?.quest_id === 'quest-supplies')
  assert.equal(suppliesClockEvents.length, 0, JSON.stringify(questClockEvents.map((event) => event.payload)))
  for (const event of questClockEvents) {
    assert.equal(event.payload?.policy_id, 'skazanie:offscreen-world-v1')
    assert.equal(event.payload?.proof_fact_ids, undefined)
  }
  assert.equal(events.some((event) => event.event_type === 'QuestResolved'), false)
  assert.equal(state.worldMemory.quests[0].clock.current, 2)
  assert.equal(state.worldMemory.quests[0].status, 'active')
})

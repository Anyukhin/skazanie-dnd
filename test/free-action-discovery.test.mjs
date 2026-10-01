// Улика из удачной проверки свободного действия.
//
// Поручение продвигается только фактом `discovery`/`quest_progress` с
// подтверждённым источником (`questProgressEvidenceFor`). До этой правки такие
// факты не создавал ни один модуль: удачный осмотр по делу отряда не давал
// ничего, и главная нить могла закрыться лишь провалом или отказом.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ActionAdjudicator } from '../server/action-adjudicator.mjs'
import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import { questProgressEvidenceFor } from '../server/campaign-loop-policy.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { Narrator } from '../server/narrator.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { FileTraceStore } from '../server/trace-store.mjs'
import { freeActionDiscoveryCommands } from '../server/world-memory.mjs'

const CAMPAIGN_ID = 'DISCOVERY-1'

function cells(width = 5, height = 3) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true,
  }))
}

function harbourState({ questVisibility = 'party', clock = { current: 1, max: 2 } } = {}) {
  return normalizeCampaignState({
    sessionCode: CAMPAIGN_ID,
    ruleset_id: 'srd_5_2_1',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero', character: 'Тордин', characterClass: 'barbarian', level: 1,
      hp: 15, maxHp: 15, armor: 14, speed: 25, proficiency: 2,
      abilities: { str: 15, dex: 14, con: 15, int: 8, wis: 12, cha: 8 },
      classSkillProficiencies: ['perception'], inventory: [], x: 0, y: 0,
    }],
    enemies: [],
    scene: { title: 'Причал в тумане', location: 'Аквилон', objective: 'Начать расследование исчезновений рыбаков', cells: cells() },
    mechanics: {
      positions: { hero: { x: 0, y: 0 } },
      combat: { active: false, round: 0, active_index: 0, initiative: [], action_economy: {} },
      world_time: { elapsed_minutes: 0 },
    },
    worldMemory: {
      entities: [{ id: 'location:harbour', kind: 'location', name: 'Аквилон', summary: '', aliases: [], visibility: 'party', tags: [] }],
      facts: [],
      quests: [{
        id: 'quest:chapter:1',
        title: 'Начать расследование исчезновений рыбаков',
        summary: 'Исчезновения рыбаков и ночные затемнения.',
        status: 'active',
        visibility: questVisibility,
        entity_ids: ['location:harbour'],
        objectives: ['Начать расследование исчезновений рыбаков'],
        clock: { ...clock, label: 'Цель сцены', triggered: clock.current >= clock.max },
      }],
      knowledge: {},
    },
    autonomy: { pacing: { phase: 'development', tension: 40 }, director_history: [], director_outcomes: [] },
  })
}

// Риск «minor»: без риска игра засчитывает осмотр автоуспехом, без броска.
// Автоуспех улики не даёт — иначе поручение решалось бы повтором одной фразы.
const perceptionReading = (overrides = {}) => ({
  goal_summary: 'Найти на причале следы пропавших рыбаков',
  approach_summary: 'Осматриваю доски, сваи и канаты',
  obstacle: 'туман',
  ability: 'wis',
  skill: 'perception',
  plausibility: 'plausible',
  risk: 'minor',
  required_means: [],
  action_cost: 'action',
  effect: 'none',
  effect_target: '',
  hazard: '',
  prop_id: '',
  target_id: '',
  item_id: '',
  proficiency: 'proficient',
  consequence_type: 'time',
  ...overrides,
})

async function fixture(t, { state = harbourState(), reading = perceptionReading(), dice = 19 } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-discovery-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const reducer = { reducer: applyGameEvent, normalizeState: normalizeCampaignState }
  const eventStore = new FileEventStore({ rootDir, ...reducer })
  await eventStore.initializeCampaign({ campaign_id: CAMPAIGN_ID, initial_state: state })
  const rulesEngine = new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([dice, ...Array(200).fill(3)]) }) })
  const actionAdjudicator = new ActionAdjudicator({ llmClient: { completeJson: async () => reading } })
  const autonomy = new AutonomousCampaignOrchestrator({ eventStore, rulesEngine, actionAdjudicator, now: () => 1_790_000_000_000 })
  return { rootDir, reducer, eventStore, autonomy }
}

const inspect = (autonomy, key = 'inspect-pier') => autonomy.handleUnknownAction({
  campaignId: CAMPAIGN_ID, playerId: 'hero', action: 'Осматриваю причал в поисках следов пропавших рыбаков', idempotencyKey: key,
})

const discoveries = (events) => events
  .filter((event) => event.event_type === 'WorldFactRecorded' && event.payload.fact.predicate === 'discovery')

test('удачный осмотр по делу отряда оставляет улику, и Режиссёр продвигает по ней поручение', async (t) => {
  const { rootDir, reducer, eventStore, autonomy } = await fixture(t)
  const result = await inspect(autonomy)
  assert.equal(result.kind, 'check_success')

  const check = result.events.find((event) => event.event_type === 'AbilityCheckResolved')
  const [recorded] = discoveries(result.events)
  assert.ok(recorded, 'успех по теме поручения обязан оставить улику')
  assert.equal(recorded.payload.fact.subject_id, 'location:harbour')
  assert.deepEqual(recorded.payload.fact.source_event_ids, [check.event_id])
  assert.match(recorded.payload.fact.summary, /^Найдена зацепка по делу «Начать расследование исчезновений рыбаков»: найти на причале следы пропавших рыбаков — удачная проверка «Восприятие» принесла результат\.$/u)
  assert.equal(questProgressEvidenceFor(result.state, 'quest:chapter:1').length, 1, 'улика принимается как доказательство')

  const advanced = await autonomy.runIntent({
    campaignId: CAMPAIGN_ID, intent: { type: 'advance_quest_clock', quest_id: 'quest:chapter:1' }, idempotencyKey: 'director-advance',
  })
  const events = await eventStore.getEvents(CAMPAIGN_ID)
  const clock = events.find((event) => event.event_type === 'QuestClockAdvanced')
  assert.deepEqual(clock.payload.proof_fact_ids, [recorded.payload.fact.id])
  assert.equal(advanced.state.worldMemory.quests[0].status, 'completed', 'часы 2/2 с доказательством закрывают поручение успехом')

  // Тот же поток событий после перезапуска даёт то же состояние.
  const replayed = new FileEventStore({ rootDir, ...reducer })
  const loaded = await replayed.load(CAMPAIGN_ID)
  assert.deepEqual(loaded.state.worldMemory.quests, advanced.state.worldMemory.quests)
})

test('повтор того же хода не создаёт второй улики', async (t) => {
  const { eventStore, autonomy } = await fixture(t)
  await inspect(autonomy, 'same-key')
  await inspect(autonomy, 'same-key')
  assert.equal(discoveries(await eventStore.getEvents(CAMPAIGN_ID)).length, 1)
})

test('провал проверки улики не даёт', async (t) => {
  const { autonomy } = await fixture(t, { dice: 2 })
  const result = await inspect(autonomy)
  assert.equal(result.kind, 'check_failure')
  assert.equal(discoveries(result.events).length, 0)
})

test('распознанная проверка навыка («Осматриваю зал…») тоже оставляет улику, и повтор хода её не дублирует', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-discovery-orchestrator-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const eventStore = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  const initial = harbourState()
  await eventStore.initializeCampaign({ campaign_id: CAMPAIGN_ID, initial_state: initial })
  const orchestrator = new GameOrchestrator({
    rulesEngine: new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([19, ...Array(50).fill(3)]) }) }),
    eventStore,
    traceStore: new FileTraceStore({ rootDir: join(rootDir, 'traces') }),
    narrator: new Narrator(),
  })
  const input = {
    state: initial, playerId: 'hero', idempotencyKey: 'listen-tavern',
    message: 'Осматриваю зал таверны и прислушиваюсь к разговорам о пропавших рыбаках',
  }
  const first = await orchestrator.handle(input)
  const check = first.mechanics.find((event) => event.event_type === 'AbilityCheckResolved')
  assert.ok(check, 'фраза распознаётся как проверка навыка')
  assert.equal(check.payload.success, true)
  const clue = first.mechanics.find((event) => event.event_type === 'WorldFactRecorded' && event.payload.fact.predicate === 'discovery')
  assert.ok(clue, 'удачная проверка по делу оставляет улику и на этом пути')
  assert.deepEqual(clue.payload.fact.source_event_ids, [check.event_id])
  assert.equal(questProgressEvidenceFor(first.authoritative_state, 'quest:chapter:1').length, 1)

  await orchestrator.handle(input)
  assert.equal(discoveries(await eventStore.getEvents(CAMPAIGN_ID)).length, 1, 'повтор хода не пишет вторую улику')
})

test('улику дают только познавательный навык, тема поручения и видимое отряду поручение', () => {
  const state = harbourState()
  const checkEvent = { event_id: 'evt-check', event_type: 'AbilityCheckResolved', payload: { success: true } }
  const base = { checkEvent, skill: 'perception', actionText: 'Осматриваю причал в поисках следов пропавших рыбаков' }
  assert.equal(freeActionDiscoveryCommands(state, base).length, 1)

  assert.deepEqual(freeActionDiscoveryCommands(state, { ...base, skill: 'athletics' }), [], 'Атлетика — способ сделать, а не узнать')
  assert.deepEqual(freeActionDiscoveryCommands(state, { ...base, actionText: 'Осматриваю лодку на предмет течи' }), [], 'не про это дело')
  assert.deepEqual(freeActionDiscoveryCommands(state, { ...base, checkEvent: { ...checkEvent, payload: { success: false } } }), [])
  assert.deepEqual(freeActionDiscoveryCommands(harbourState({ questVisibility: 'gm_only' }), base), [], 'скрытое поручение не раскрывается уликой')

  const first = freeActionDiscoveryCommands(state, base)[0].fact.id
  assert.equal(freeActionDiscoveryCommands(state, base)[0].fact.id, first, 'id улики детерминирован')
})

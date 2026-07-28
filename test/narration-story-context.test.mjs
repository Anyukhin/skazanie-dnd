import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator, NARRATION_STORY_LIMITS, narrationStoryContext } from '../server/game-orchestrator.mjs'
import { applyGameEvent, normalizeCampaignState, RulesEngine } from '../server/rules-engine.mjs'
import { assertNarrationBrief } from '../server/security.mjs'

function campaign(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'NARRATION-STORY-CONTEXT',
    activePlayerId: 'hero',
    partyMemberIds: ['hero', 'rogue'],
    scene: { title: 'Трактир «Пустой кубок»', location: 'Трактир «Пустой кубок»', objective: 'Узнать, куда пропал караван', cells: [] },
    players: [
      { id: 'hero', character: 'Ада', hp: 10, maxHp: 10, abilities: { str: 12 }, inventory: [] },
      { id: 'rogue', character: 'Рен', hp: 9, maxHp: 10, abilities: { dex: 14 }, inventory: [] },
    ],
    ...overrides,
  })
}

function storyWorldMemory() {
  return {
    entities: [
      { id: 'location:tavern', kind: 'location', name: 'Трактир «Пустой кубок»', summary: 'Трактир у северных ворот.', visibility: 'party' },
      { id: 'npc:mira', kind: 'npc', name: 'Мира', summary: 'Хозяйка трактира.', visibility: 'party' },
    ],
    facts: [],
    relationships: [],
    quests: [
      {
        id: 'quest:caravan', title: 'Пропавший караван', summary: 'Караван из Волчьего брода не дошёл до города.',
        status: 'active', visibility: 'party', entity_ids: [], objectives: ['Опросить очевидцев', 'Найти след на северной дороге'],
        clock: { current: 1, max: 4, label: 'След остывает' },
      },
      {
        id: 'quest:secret', title: 'СКРЫТЫЙ ЗАМЫСЕЛ ВЕДУЩЕГО', summary: 'Секретная линия, о которой группа не знает.',
        status: 'active', visibility: 'gm_only', entity_ids: [], objectives: [],
      },
      {
        id: 'quest:done', title: 'Завершённый пролог', summary: 'Уже закрыт.',
        status: 'completed', visibility: 'party', entity_ids: [], objectives: [],
      },
    ],
    threads: [
      { id: 'thread:smugglers', title: 'Контрабандисты у ворот', summary: 'Кто-то платит страже за молчание.', status: 'active', visibility: 'party', entity_ids: [], quest_ids: [] },
      { id: 'thread:gm', title: 'ТАЙНАЯ НИТЬ', summary: 'Нельзя показывать.', status: 'active', visibility: 'gm_only', entity_ids: [], quest_ids: [] },
    ],
    epistemic_claims: [],
    summaries: [
      {
        id: 'summary:prologue', kind: 'scene', title: 'Прибытие в город', summary: 'Группа прибыла в город и узнала о пропаже каравана.',
        visibility: 'party', entity_ids: [], thread_ids: [], source_event_ids: ['event:prologue'],
      },
      {
        id: 'summary:gm', kind: 'scene', title: 'СКРЫТОЕ РЕЗЮМЕ', summary: 'Только для ведущего.',
        visibility: 'gm_only', entity_ids: [], thread_ids: [], source_event_ids: ['event:gm'],
      },
    ],
    knowledge_ledger: [],
  }
}

function storySocial() {
  return {
    npcs: [
      {
        id: 'npc:mira', name: 'Мира', role: 'хозяйка трактира', location: 'Трактир «Пустой кубок»',
        public_summary: 'Держит трактир двадцать лет и знает всех.', voice: 'Говорит быстро, с прибаутками.',
        visibility: 'party', available: true,
      },
      {
        id: 'npc:elsewhere', name: 'Страж далёкой заставы', role: 'страж', location: 'Дальняя застава',
        public_summary: 'Служит на другом конце тракта.', voice: 'Немногословен.',
        visibility: 'party', available: true,
      },
      {
        id: 'npc:hidden', name: 'ТАЙНЫЙ НАБЛЮДАТЕЛЬ', role: 'шпион', location: 'Трактир «Пустой кубок»',
        public_summary: 'Игроки о нём не знают.', voice: 'Шепчет.',
        visibility: 'gm_only', available: true,
      },
    ],
    relationships: { 'npc:mira': { hero: 30, rogue: -25 } },
    promises: [
      {
        id: 'promise:map', npc_id: 'npc:mira', hero_id: 'hero', direction: 'npc_to_party',
        text: 'Мира обещала показать карту старых троп.', due_hint: 'к вечеру', status: 'open', visibility: 'party',
      },
      {
        id: 'promise:done', npc_id: 'npc:mira', hero_id: 'hero', direction: 'npc_to_party',
        text: 'Уже исполненное обещание.', status: 'fulfilled', visibility: 'party',
      },
      {
        id: 'promise:far', npc_id: 'npc:elsewhere', hero_id: 'hero', direction: 'party_to_npc',
        text: 'Обещание NPC не из этой сцены.', status: 'open', visibility: 'party',
      },
    ],
    conversations: [],
  }
}

test('story context собирает квесты, нити, резюме, отряд, NPC сцены и обещания без скрытого', () => {
  const state = campaign({ worldMemory: storyWorldMemory(), social: storySocial() })
  const context = narrationStoryContext(state, { playerId: 'hero', partyIds: ['hero', 'rogue'], isPartyMember: true })

  // Нормализация добавляет квест текущей главы из цели сцены — он тоже активен.
  assert.deepEqual(context.active_quests.map((quest) => quest.title), ['Пропавший караван', 'Узнать, куда пропал караван'])
  assert.deepEqual(context.active_quests[0].objectives, ['Опросить очевидцев', 'Найти след на северной дороге'])
  assert.deepEqual(context.active_quests[0].clock, { label: 'След остывает', current: 1, max: 4 })
  assert.deepEqual(context.active_threads.map((thread) => thread.title), ['Контрабандисты у ворот'])
  assert.deepEqual(context.recent_summaries.map((summary) => summary.title), ['Прибытие в город'])
  assert.deepEqual(context.heroes.map((hero) => hero.name), ['Ада', 'Рен'])
  assert.deepEqual(context.present_npcs.map((npc) => npc.name), ['Мира'])
  assert.equal(context.present_npcs[0].voice, 'Говорит быстро, с прибаутками.')
  assert.equal(context.present_npcs[0].relationship, 'friendly')
  assert.deepEqual(context.open_promises.map((promise) => promise.text), ['Мира обещала показать карту старых троп.'])

  const serialized = JSON.stringify(context)
  assert.doesNotMatch(serialized, /СКРЫТЫЙ ЗАМЫСЕЛ|ТАЙНАЯ НИТЬ|СКРЫТОЕ РЕЗЮМЕ|ТАЙНЫЙ НАБЛЮДАТЕЛЬ/u)
  assert.doesNotMatch(serialized, /Дальняя застава/u)
})

test('story context смотрит на отношение глазами конкретного героя', () => {
  const state = campaign({ worldMemory: storyWorldMemory(), social: storySocial() })
  const forRogue = narrationStoryContext(state, { playerId: 'rogue', partyIds: ['hero', 'rogue'], isPartyMember: true })
  assert.equal(forRogue.present_npcs[0].relationship, 'unfriendly')
})

test('story context ограничен явными пределами', () => {
  const quests = Array.from({ length: 10 }, (_, index) => ({
    id: `quest:${index}`, title: `Квест ${index}`, summary: 'Активен.', status: 'active', visibility: 'party', entity_ids: [], objectives: [],
  }))
  const state = campaign({ worldMemory: { ...storyWorldMemory(), quests }, social: storySocial() })
  const context = narrationStoryContext(state, { playerId: 'hero', partyIds: ['hero'], isPartyMember: true })
  assert.equal(context.active_quests.length, NARRATION_STORY_LIMITS.quests)
  // Берутся последние по порядку записи: свежее ближе к текущей сцене, а квест
  // текущей главы, добавленный нормализацией из цели сцены, — самый новый.
  assert.deepEqual(context.active_quests.map((quest) => quest.title), ['Квест 9', 'Узнать, куда пропал караван'])
})

test('NarrationBrief оркестратора несёт story_context и проходит проверку скрытого', async () => {
  const state = campaign({ worldMemory: storyWorldMemory(), social: storySocial() })
  const root = mkdtempSync(join(tmpdir(), 'skazanie-narration-story-'))
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState,
  })
  await eventStore.initializeCampaign({ campaign_id: state.sessionCode, initial_state: state })
  let brief = null
  const orchestrator = new GameOrchestrator({
    intentParser: { parse: async ({ message }) => ({
      actor_id: 'hero', intent: 'free_action', approach: 'test', targets: [], mentioned_entities: [],
      missing_information: [], requires_clarification: false, confidence: 1, raw_message: message,
    }) },
    adjudicator: { createPlan: async () => ({
      rule_ids: [], proposed_commands: [{ command_type: 'ApplyHealing', actor_id: 'hero', amount: 1 }], roll_requests: [],
      ruling_required: false, ruling_draft: null, narration_constraints: [], confidence: 1,
    }) },
    narrator: { render: async (value) => {
      brief = value
      return { narration: 'Подтверждённое последствие.', suggestions: [], verification: { valid: true }, provider: 'test' }
    } },
    rulesEngine: new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([]) }) }),
    eventStore,
    idFactory: () => 'story-turn',
  })
  const response = await orchestrator.handle({
    state, campaignId: state.sessionCode, playerId: 'hero', message: 'Расспрашиваю Миру о караване',
    idempotencyKey: 'story-context-1', user: { role: 'player' },
  })
  assert.equal(response.provider, 'test')
  assert.ok(brief)
  assertNarrationBrief(brief)
  const story = brief.known_environment.story_context
  assert.ok(story, 'story_context обязан присутствовать в brief')
  assert.deepEqual(story.active_quests.map((quest) => quest.title), ['Пропавший караван', 'Узнать, куда пропал караван'])
  assert.deepEqual(story.present_npcs.map((npc) => npc.name), ['Мира'])
  assert.deepEqual(story.recent_summaries.map((summary) => summary.title), ['Прибытие в город'])
  assert.doesNotMatch(JSON.stringify(brief), /СКРЫТЫЙ ЗАМЫСЕЛ|ТАЙНАЯ НИТЬ|СКРЫТОЕ РЕЗЮМЕ|ТАЙНЫЙ НАБЛЮДАТЕЛЬ/u)
})

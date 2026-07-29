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
import { FileTraceStore } from '../server/trace-store.mjs'

function campaign(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'NARRATION-STORY-CONTEXT',
    activePlayerId: 'hero',
    partyMemberIds: ['hero', 'rogue'],
    scene: { title: 'Трактир «Пустой кубок»', location: 'Трактир «Пустой кубок»', objective: 'Узнать, куда пропал караван', cells: [] },
    adventure: {
      chapter: 3,
      history: [
        {
          title: 'Решение у заставы', location: 'Северная застава',
          objective: 'Выбрать, кому доверить найденную печать',
          outcome: 'Отряд оставил печать у себя', status: 'resolved', visibility: 'party',
        },
        {
          title: 'СКРЫТОЕ РЕШЕНИЕ ВЕДУЩЕГО', location: 'Тайник',
          objective: 'Скрытая цель', outcome: 'Скрытое последствие', visibility: 'gm_only',
        },
      ],
    },
    players: [
      {
        id: 'hero', character: 'Ада', role: 'Следопыт — уровень 3', background: 'проводница северных трактов',
        hp: 10, maxHp: 10, abilities: { str: 12 }, inventory: [],
      },
      {
        id: 'rogue', character: 'Рен', role: 'Плут — уровень 3', background: 'бывший городской дозорный',
        hp: 9, maxHp: 10, abilities: { dex: 14 }, inventory: [],
      },
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
        speech_profile: {
          pace: 'быстро, короткими фразами',
          lexicon: 'трактирные поговорки и бытовые слова',
          mannerism: 'заканчивает важную мысль словами «так-то вернее»',
        },
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
    conversations: [
      {
        id: 'conversation:gate', npc_id: 'npc:mira', hero_id: 'rogue',
        player_message: 'Кто проезжал через северные ворота?',
        npc_reply: 'Возчик в синем плаще спрашивал о Волчьем броде.',
        stance: 'neutral', visibility: 'party',
      },
      {
        id: 'conversation:private', npc_id: 'npc:mira', hero_id: 'hero',
        player_message: 'СКРЫТЫЙ ВОПРОС', npc_reply: 'СКРЫТЫЙ ОТВЕТ',
        stance: 'neutral', visibility: 'specific_player',
      },
    ],
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
  assert.equal(context.recent_summaries[0].id, 'summary:prologue')
  assert.equal(context.recent_summaries[0].kind, 'scene')
  assert.deepEqual(context.recent_decisions.map((entry) => entry.title), ['Решение у заставы'])
  assert.deepEqual(context.heroes, [
    {
      id: 'hero', name: 'Ада', is_viewer: true,
      class_name: 'Следопыт', background: 'проводница северных трактов',
    },
    { id: 'rogue', name: 'Рен', is_viewer: false },
  ])
  assert.deepEqual(context.present_npcs.map((npc) => npc.name), ['Мира'])
  assert.equal(context.present_npcs[0].voice, 'Говорит быстро, с прибаутками.')
  assert.deepEqual(context.present_npcs[0].speech_profile, {
    pace: 'быстро, короткими фразами',
    lexicon: 'трактирные поговорки и бытовые слова',
    mannerism: 'заканчивает важную мысль словами «так-то вернее»',
  })
  assert.equal(context.present_npcs[0].relationship, 'friendly')
  assert.deepEqual(context.open_promises.map((promise) => promise.text), ['Мира обещала показать карту старых троп.'])
  assert.deepEqual(context.recent_interactions, [{
    npc: 'Мира', hero: 'Рен',
    player_message: 'Кто проезжал через северные ворота?',
    npc_reply: 'Возчик в синем плаще спрашивал о Волчьем броде.',
    stance: 'neutral',
  }])

  const serialized = JSON.stringify(context)
  assert.doesNotMatch(serialized, /СКРЫТЫЙ ЗАМЫСЕЛ|ТАЙНАЯ НИТЬ|СКРЫТОЕ РЕЗЮМЕ|ТАЙНЫЙ НАБЛЮДАТЕЛЬ|СКРЫТОЕ РЕШЕНИЕ|СКРЫТЫЙ ВОПРОС|СКРЫТЫЙ ОТВЕТ/u)
  assert.doesNotMatch(serialized, /Дальняя застава/u)
})

test('story context смотрит на отношение глазами конкретного героя', () => {
  const state = campaign({ worldMemory: storyWorldMemory(), social: storySocial() })
  const forRogue = narrationStoryContext(state, { playerId: 'rogue', partyIds: ['hero', 'rogue'], isPartyMember: true })
  assert.equal(forRogue.present_npcs[0].relationship, 'unfriendly')
  assert.deepEqual(forRogue.heroes, [
    { id: 'hero', name: 'Ада', is_viewer: false },
    {
      id: 'rogue', name: 'Рен', is_viewer: true,
      class_name: 'Плут', background: 'бывший городской дозорный',
    },
  ])
})

test('story context ограничен явными пределами', () => {
  const quests = Array.from({ length: 10 }, (_, index) => ({
    id: `quest:${index}`, title: `Квест ${index}`, summary: 'Активен.', status: 'active', visibility: 'party', entity_ids: [], objectives: [],
  }))
  const social = storySocial()
  social.conversations = Array.from({ length: 10 }, (_, index) => ({
    id: `conversation:${index}`, npc_id: 'npc:mira', hero_id: 'hero',
    player_message: `Вопрос ${index}`, npc_reply: `Ответ ${index}`,
    stance: 'neutral', visibility: 'party',
  }))
  const state = campaign({ worldMemory: { ...storyWorldMemory(), quests }, social })
  const context = narrationStoryContext(state, { playerId: 'hero', partyIds: ['hero'], isPartyMember: true })
  assert.equal(context.active_quests.length, NARRATION_STORY_LIMITS.quests)
  assert.equal(context.recent_interactions.length, NARRATION_STORY_LIMITS.interactions)
  assert.deepEqual(context.recent_interactions.map((entry) => entry.npc_reply), ['Ответ 6', 'Ответ 7', 'Ответ 8', 'Ответ 9'])
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
  const traceStore = new FileTraceStore({ rootDir: join(root, 'traces') })
  traceStore.save({
    turn_id: 'previous-story-turn',
    campaign_id: state.sessionCode,
    narration_result: { narration: 'Недавний рассказ о печати у заставы.' },
    created_at: '2026-07-29T20:00:00.000Z',
  })
  let brief = null
  let renderOptions = null
  const orchestrator = new GameOrchestrator({
    intentParser: { parse: async ({ message }) => ({
      actor_id: 'hero', intent: 'free_action', approach: 'test', targets: [], mentioned_entities: [],
      missing_information: [], requires_clarification: false, confidence: 1, raw_message: message,
    }) },
    adjudicator: { createPlan: async () => ({
      rule_ids: [], proposed_commands: [{ command_type: 'ApplyHealing', actor_id: 'hero', amount: 1 }], roll_requests: [],
      ruling_required: false, ruling_draft: null, narration_constraints: [], confidence: 1,
    }) },
    narrator: { render: async (value, options) => {
      brief = value
      renderOptions = options
      return { narration: 'Подтверждённое последствие.', suggestions: [], verification: { valid: true }, provider: 'test' }
    } },
    rulesEngine: new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([]) }) }),
    eventStore,
    traceStore,
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
  assert.deepEqual(renderOptions.recentNarrations, ['Недавний рассказ о печати у заставы.'])
  assert.doesNotMatch(JSON.stringify(brief), /СКРЫТЫЙ ЗАМЫСЕЛ|ТАЙНАЯ НИТЬ|СКРЫТОЕ РЕЗЮМЕ|ТАЙНЫЙ НАБЛЮДАТЕЛЬ/u)
})

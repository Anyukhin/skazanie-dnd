import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  normalizeCampaignState,
  replayEvents,
  resolveCommands,
} from '../server/rules-engine.mjs'
import {
  buildSceneSummaryText,
  eventsSinceSceneStart,
  notableSceneMoments,
  sceneSummaryFor,
} from '../server/scene-summary.mjs'
import { buildNarrationBrief } from '../server/security.mjs'
import { worldMemoryForViewer } from '../server/world-memory.mjs'

/**
 * Задача 2.1 плана. Событие `NarrativeSummaryRecorded` пишет сам обработчик
 * `AdvanceScene`, но до сих пор в сводку уходила дежурная фраза Архитектора.
 * Сторож закрывает содержимое: сводка обязана держаться реальных событий сцены
 * и оставаться честной там, где событий не было.
 */

const event = (event_type, payload = {}, event_id = `event-${event_type}`) => ({ event_type, payload, event_id })

function stateWithScene(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'SUMMARY',
    campaign: 'Сводки',
    scene: { title: 'Драка в трактире', location: 'Трактир «Кабанья голова»', turn: 3, cells: [] },
    players: [{ id: 'hero-1', character: 'Ада', hp: 10, maxHp: 10 }],
    ...overrides,
  })
}

test('события сцены отсчитываются от последнего перехода', () => {
  const events = [
    event('RulingRecorded', {}, 'e1'),
    event('SceneAdvanced', {}, 'e2'),
    event('RulingRecorded', {}, 'e3'),
    event('SceneAdvanced', {}, 'e4'),
    event('EncounterEnded', {}, 'e5'),
    event('RulingRecorded', {}, 'e6'),
  ]
  assert.deepEqual(eventsSinceSceneStart(events).map((entry) => entry.event_id), ['e5', 'e6'])
  // У первой сцены кампании перехода ещё не было — берётся весь поток.
  assert.deepEqual(eventsSinceSceneStart([event('RulingRecorded', {}, 'e1')]).map((entry) => entry.event_id), ['e1'])
  assert.deepEqual(eventsSinceSceneStart([]), [])
})

test('заметными считаются последствия и исходы, а не каждый бросок', () => {
  const moments = notableSceneMoments([
    event('WorldFactRecorded', { fact: { predicate: 'scene_change', summary: 'Отряд поджёг разлитое масло' } }),
    event('WorldFactRecorded', { fact: { predicate: 'encounter_outcome', summary: 'Обычный факт встречи' } }),
    event('EncounterOutcomeRecorded', { outcome: 'victory' }),
    event('RulingRecorded', { ruling: { question: 'Прыгаю с люстры на огра', outcome: 'success', stakes: { difficulty: 15 } } }),
    // Авто-успех без ставок — бытовое действие, в память сцены не идёт.
    event('RulingRecorded', { ruling: { question: 'Открываю незапертую дверь', outcome: 'success', stakes: null } }),
    event('NpcPromiseRecorded', { promise: { text: 'Вернуть Мире долг до заката' } }),
    event('MerchantPurchaseCompleted', { item: { name: 'Верёвка' }, quantity: 2 }),
    event('AbilityCheckResolved', { success: true }),
  ])
  assert.ok(moments.includes('Отряд поджёг разлитое масло'))
  assert.ok(moments.includes('столкновение завершилось: victory'))
  assert.ok(moments.includes('Прыгаю с люстры на огра — удалось'))
  assert.ok(moments.includes('дано обещание: Вернуть Мире долг до заката'))
  assert.ok(moments.includes('куплено: Верёвка ×2'))
  assert.ok(!moments.some((moment) => moment.includes('незапертую дверь')), 'авто-успех не заметен')
  assert.ok(!moments.some((moment) => moment.includes('Обычный факт встречи')), 'чужой предикат не заметен')
  assert.ok(moments.length <= 5, 'сводка ограничена по длине')
})

test('текст сводки отвечает где были, что случилось и куда ушли', () => {
  const { title, summary } = buildSceneSummaryText({
    state: stateWithScene(),
    events: [event('WorldFactRecorded', { fact: { predicate: 'scene_change', summary: 'Отряд поджёг разлитое масло' } })],
    decision: 'уйти на север по следу каравана',
    destination: 'Северный тракт',
  })
  assert.equal(title, 'Драка в трактире')
  assert.match(summary, /Трактир «Кабанья голова»/u)
  assert.match(summary, /Отряд поджёг разлитое масло/u)
  assert.match(summary, /Северный тракт/u)
  assert.match(summary, /уйти на север по следу каравана/u)
})

test('проходная сцена описывается честно, а не дополняется выдумкой', () => {
  const { summary } = buildSceneSummaryText({
    state: stateWithScene(),
    events: [event('AbilityCheckResolved', { success: true })],
    decision: '',
    destination: '',
  })
  assert.match(summary, /Ничего, что изменило бы мир/u)
  assert.match(summary, /Отряд двинулся дальше/u)
})

test('сцена без событий не даёт сводки, и движок остаётся на прежнем поведении', () => {
  const state = stateWithScene()
  // Пустая строка означает «мне нечего сказать»: вызывающий не ветвится, а
  // `AdvanceScene` оставляет прежний `outcome` Архитектора.
  assert.equal(sceneSummaryFor({ state, events: [] }), '')
  assert.ok(sceneSummaryFor({ state, events: [event('EncounterEnded', { reason: 'victory' }, 'evt-1')] }))
})

test('сводка доезжает до памяти мира через AdvanceScene, переживает replay и видна отряду', () => {
  const state = stateWithScene()
  const summary = sceneSummaryFor({
    state,
    events: [
      event('WorldFactRecorded', { fact: { predicate: 'scene_change', summary: 'Отряд поджёг разлитое масло' } }, 'evt-1'),
      event('EncounterEnded', { reason: 'victory' }, 'evt-2'),
    ],
    decision: 'уйти на север по следу каравана',
    destination: 'Северный тракт',
  })
  const diceService = new DiceService({ rng: new SequenceDiceRng([]) })
  const resolved = resolveCommands([{
    command_type: 'AdvanceScene',
    scene_args: { title: 'Северный тракт', location: 'Северный тракт', scene_summary: summary },
  }], state, { diceService, context: { isAdmin: true } })

  const summaryEvent = resolved.events.find((entry) => entry.event_type === 'NarrativeSummaryRecorded')
  assert.ok(summaryEvent, 'AdvanceScene пишет сводку сам — второй команды не нужно')
  assert.equal(
    resolved.events.filter((entry) => entry.event_type === 'NarrativeSummaryRecorded').length,
    1,
    'сводка на переход ровно одна',
  )
  // Заголовок движок берёт из покидаемой сцены, тело — из нашей сборки.
  assert.equal(summaryEvent.payload.summary.title, 'Драка в трактире')
  assert.match(summaryEvent.payload.summary.summary, /Отряд поджёг разлитое масло/u)
  assert.match(summaryEvent.payload.summary.summary, /Северный тракт/u)
  assert.equal(summaryEvent.payload.summary.visibility, 'party')
  assert.ok(summaryEvent.payload.summary.source_event_ids.length, 'провенанс проставлен движком')

  const stored = resolved.state.worldMemory.summaries.at(-1)
  assert.match(stored.summary, /Отряд поджёг разлитое масло/u)

  // Replay даёт то же состояние; повтор того же события не удваивает запись.
  assert.deepEqual(replayEvents(state, resolved.events), resolved.state)
  const replayed = replayEvents(state, [...resolved.events, ...resolved.events])
  assert.equal(replayed.worldMemory.summaries.filter((entry) => entry.id === stored.id).length, 1)

  const visible = worldMemoryForViewer(resolved.state.worldMemory, { playerId: 'hero-1', isPartyMember: true })
  assert.ok((visible.summaries ?? []).some((entry) => entry.id === stored.id), 'party-сводка доходит до игрока')
  const hidden = worldMemoryForViewer(
    { ...resolved.state.worldMemory, summaries: [{ ...stored, id: 'summary:secret', visibility: 'gm_only' }] },
    { playerId: 'hero-1', isPartyMember: true },
  )
  assert.equal((hidden.summaries ?? []).some((entry) => entry.id === 'summary:secret'), false)
})

// Задача C брифа: проверить, доходят ли сводки до Рассказчика. Доходят —
// `story_context.recent_summaries` собирает game-orchestrator, а `narrator.mjs`
// читает их в `narratorMemoryFocus`. Опасное место — проекция брифа: она
// вырезает закрытые узлы, и молча потерять сводку здесь было бы легко.
test('сводки и нити переживают проекцию брифа и доходят до Рассказчика', () => {
  const brief = buildNarrationBrief({
    visible_events: [],
    visible_state_changes: [],
    permitted_npc_reactions: [],
    known_environment: {
      scene: { title: 'Северный тракт' },
      story_context: {
        recent_summaries: [{ id: 'summary:1', kind: 'scene', title: 'Драка в трактире', summary: 'Отряд поджёг разлитое масло' }],
        active_threads: [{ title: 'Сгоревшая мельница', summary: 'Последствия ещё не разрешены' }],
      },
    },
    viewer: { playerId: 'hero-1', partyIds: ['hero-1'], isPartyMember: true },
  })
  const story = brief.known_environment.story_context
  assert.equal(story.recent_summaries.length, 1)
  assert.equal(story.recent_summaries[0].summary, 'Отряд поджёг разлитое масло')
  assert.equal(story.active_threads.length, 1)
})

test('без scene_summary движок сохраняет прежнее поведение и берёт outcome Архитектора', () => {
  const diceService = new DiceService({ rng: new SequenceDiceRng([]) })
  const resolved = resolveCommands([{
    command_type: 'AdvanceScene',
    scene_args: { title: 'Северный тракт', location: 'Северный тракт', outcome: 'Отряд покинул трактир.' },
  }], stateWithScene(), { diceService, context: { isAdmin: true } })
  const summaryEvent = resolved.events.find((entry) => entry.event_type === 'NarrativeSummaryRecorded')
  assert.equal(summaryEvent.payload.summary.summary, 'Отряд покинул трактир.')
})

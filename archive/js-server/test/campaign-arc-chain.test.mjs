import assert from 'node:assert/strict'
import test from 'node:test'

import {
  campaignArcCarryOver,
  campaignCanAdvanceArc,
  lifecycleEventForAction,
} from '../server/campaign-lifecycle.mjs'
import {
  MAX_CAMPAIGN_ARCS,
  buildCampaignArcPlan,
  campaignArcPosition,
} from '../server/campaign-loop-policy.mjs'
import { DiceService } from '../server/dice-service.mjs'
import {
  RulesValidationError,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'

/**
 * Кампания ровно в тот момент, который закрывает арку: главная нить разрешена,
 * hard-бой целевой сцены завершён и подтверждён. Из этой точки расходятся два
 * исхода — финал кампании и следующая арка теми же героями.
 */
function resolvedArc({ seed = 'arc-chain-seed', arcNumber = 1 } = {}) {
  const arc = buildCampaignArcPlan(seed, arcNumber)
  return normalizeCampaignState({
    sessionCode: 'ARC-CHAIN',
    campaign: 'Предел зимы',
    campaignConcept: { arc, worldSummary: 'Северные земли под бурей.' },
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      character: 'Ада',
      level: 4,
      hp: 30,
      maxHp: 30,
      xp: 2_700,
      inventory: [{ id: 'relic', name: 'Осколок бури', type: 'treasure', quantity: 1 }],
      x: 1,
      y: 1,
    }],
    scene: { title: 'Северная башня', location: 'Северная башня', objective: 'Остановить бурю', turn: 4, cells: [] },
    adventure: { chapter: arc.target_scenes, history: [{ chapter: 1, summary: 'Отряд вышел в путь.' }], visitedLocations: ['Северная башня'] },
    autonomy: {
      reputations: { 'faction:watch': 30 },
      pacing: { beat: 9, phase: 'climax', tension: 90 },
      encounter_outcomes: [{ encounter_id: 'encounter:climax', outcome: 'enemies_defeated' }],
      director_history: [{ intent: { type: 'request_encounter' } }],
      director_outcomes: [{ intent_type: 'request_encounter', state_changed: true }],
    },
    mechanics: {
      world_time: { elapsed_minutes: 600 },
      encounter: {
        id: 'encounter:climax',
        encounter_id: 'encounter:climax',
        status: 'ended',
        difficulty: 'hard',
        created_in_chapter: arc.target_scenes,
      },
    },
    worldMemory: {
      entities: [
        { id: 'tower', kind: 'location', name: 'Северная башня', summary: '', aliases: [], visibility: 'party', tags: [] },
        { id: 'faction:watch', kind: 'faction', name: 'Ночная стража', summary: '', aliases: [], visibility: 'party', tags: [] },
      ],
      facts: [{
        id: 'fact:storm', subject_id: 'tower', predicate: 'outcome', object: 'safe',
        summary: 'Башня устояла.', status: 'active', visibility: 'party',
      }],
      quests: [
        {
          id: 'quest:storm', title: 'Остановить бурю', summary: 'Буря остановлена.',
          status: 'completed', visibility: 'party', entity_ids: ['tower'], objectives: [],
          clock: { current: 4, max: 4, label: 'Прогресс', triggered: true },
        },
        {
          id: `quest:chapter:${arc.target_scenes}`, title: 'Цель финальной сцены', summary: '',
          status: 'active', visibility: 'party', entity_ids: [], objectives: [],
          clock: { current: 1, max: 2, label: 'Цель сцены', triggered: false },
        },
        {
          id: 'quest:debt', title: 'Долг перед кузнецом', summary: '',
          status: 'active', visibility: 'party', entity_ids: [], objectives: [],
          clock: { current: 1, max: 4, label: 'Обещание', triggered: false },
        },
      ],
      threads: [{ id: 'thread:heir', title: 'Наследник так и не найден', status: 'active', visibility: 'party' }],
      knowledge: {},
    },
    social: {
      npcs: [{
        id: 'smith', name: 'Борен', role: 'кузнец', location: 'Северная башня',
        public_summary: '', voice: '', goals: [], beliefs: [], known_fact_ids: [],
        visibility: 'party', available: true, tags: [],
      }],
      relationships: { smith: { hero: 4 } },
      conversations: [],
      promises: [{
        id: 'promise:blade', npc_id: 'smith', hero_id: 'hero',
        text: 'Вернуть клинок', status: 'open', visibility: 'party',
      }],
    },
  })
}

const diceService = () => new DiceService({
  rng: { randint: (minimum) => minimum },
  idFactory: () => 'roll',
  now: () => '2026-07-31T00:00:00.000Z',
})
const advance = (state, overrides = {}) => resolveCommand({
  command_type: 'AdvanceCampaignArc',
  epilogue: 'Буря стихла, и башня осталась стоять.',
  hook: 'Вернуться к незакрытому: Наследник так и не найден',
  ...overrides,
}, state, { diceService: diceService(), context: { isDirector: true } })

test('следующая арка не повторяет план предыдущей и знает свой номер', () => {
  const first = buildCampaignArcPlan('arc-chain-seed', 1)
  const second = buildCampaignArcPlan('arc-chain-seed', 2)

  assert.equal(first.arc_number, 1)
  assert.equal(second.arc_number, 2)
  assert.equal(first.seed, second.seed, 'кампания остаётся той же самой')
  assert.notEqual(
    `${first.target_scenes}:${first.arc_number}`,
    `${second.target_scenes}:${second.arc_number}`,
    'номер арки входит в план, поэтому вторая арка отличима от первой',
  )
  // Старое сохранение без номера читается как первая арка, а не теряет план.
  const legacy = normalizeCampaignState({ campaignConcept: { arc: { ...first, arc_number: undefined } } })
  assert.equal(campaignArcPosition(legacy)?.arc_number, 1)
})

test('арка закрывается тем же условием, что и кампания, но оставляет её живой', () => {
  const state = resolvedArc()
  assert.equal(campaignCanAdvanceArc(state), true)

  const resolved = advance(state)
  const [arcEvent] = resolved.events
  assert.equal(arcEvent.event_type, 'CampaignArcCompleted')
  assert.equal(arcEvent.payload.next_arc.arc_number, 2)

  const next = normalizeCampaignState(applyGameEvent(state, arcEvent))
  assert.equal(next.mechanics.campaign_lifecycle.status, 'active', 'кампания жива')
  assert.equal(next.campaignConcept.arc.arc_number, 2)
  assert.equal(next.adventure.chapter, 1, 'новая арка начинается с первой сцены')
})

test('в следующую арку переезжают герои, добыча, репутация и незакрытые нити', () => {
  const state = resolvedArc()
  const carried = campaignArcCarryOver(state)
  assert.deepEqual(carried.heroes, ['hero'])
  assert.deepEqual(carried.open_quest_ids, ['quest:debt'], 'главы прошлой арки в перенос не входят')
  assert.deepEqual(carried.open_promise_npc_ids, ['smith'])
  assert.deepEqual(carried.reputation, [{ faction_id: 'faction:watch', tier: 'respected' }])

  const next = normalizeCampaignState(applyGameEvent(state, advance(state).events[0]))
  assert.equal(next.players[0].level, 4)
  assert.equal(next.players[0].xp, 2_700)
  assert.deepEqual(next.players[0].inventory.map((item) => item.id), ['relic'])
  assert.equal(next.autonomy.reputations['faction:watch'], 30)
  assert.deepEqual(next.worldMemory.threads.map((thread) => thread.id), ['thread:heir'])
  assert.deepEqual(next.social.promises.map((promise) => promise.status), ['open'])
  assert.ok(next.worldMemory.facts.some((fact) => fact.id === 'fact:storm'), 'память мира переезжает целиком')
})

test('новая арка не наследует главы, encounter и напряжение прошлой', () => {
  const state = resolvedArc()
  const next = normalizeCampaignState(applyGameEvent(state, advance(state).events[0]))

  // Главы закрытой арки исчезают вместе с ней. Первая глава новой арки — уже
  // не они: её создаёт обычная нормализация сцены, и её часы пусты.
  const closed = `quest:chapter:${state.campaignConcept.arc.target_scenes}`
  assert.equal(next.worldMemory.quests.some((quest) => quest.id === closed), false)
  const opening = next.worldMemory.quests.find((quest) => quest.id === 'quest:chapter:1')
  assert.equal(opening?.clock?.current, 0, 'новая глава начинается с пустыми часами')
  assert.equal(next.mechanics.encounter, null)
  assert.equal(next.autonomy.pacing.phase, 'breather')
  assert.equal(next.autonomy.pacing.tension, 0)
  assert.deepEqual(next.autonomy.encounter_outcomes, [])
  assert.deepEqual(next.autonomy.director_history, [])
  assert.equal(next.scene.objective, 'Вернуться к незакрытому: Наследник так и не найден')
  // Закрытая арка остаётся в летописи вместе со своим эпилогом.
  assert.equal(next.campaignConcept.arc_history.length, 1)
  assert.equal(next.campaignConcept.arc_history[0].arc_number, 1)
  assert.match(next.campaignConcept.arc_history[0].epilogue, /Буря стихла/u)
})

test('смена арки идемпотентна при повторном replay', () => {
  const state = resolvedArc()
  const { events } = advance(state)
  const once = normalizeCampaignState(replayEvents(state, events))
  const twice = normalizeCampaignState(replayEvents(state, [...events, ...events]))

  assert.equal(twice.campaignConcept.arc.arc_number, once.campaignConcept.arc.arc_number)
  assert.equal(twice.adventure.chapter, 1)
  assert.equal(
    twice.campaignConcept.arc_history.length,
    2,
    'повтор события пишет вторую запись летописи, но не сдвигает номер арки дальше payload',
  )
})

test('смена арки — серверное решение и требует эпилога с зацепкой', () => {
  const state = resolvedArc()
  assert.throws(
    () => resolveCommand(
      { command_type: 'AdvanceCampaignArc', epilogue: 'x', hook: 'y' },
      state,
      { diceService: diceService(), context: {} },
    ),
    (error) => error instanceof RulesValidationError && error.code === 'CAMPAIGN_ARC_FORBIDDEN',
  )
  assert.throws(
    () => advance(state, { epilogue: '' }),
    (error) => error instanceof RulesValidationError && error.code === 'CAMPAIGN_EPILOGUE_REQUIRED',
  )
  assert.throws(
    () => advance(state, { hook: '' }),
    (error) => error instanceof RulesValidationError && error.code === 'CAMPAIGN_ARC_HOOK_REQUIRED',
  )

  const unresolved = resolvedArc()
  unresolved.worldMemory.quests[0].status = 'active'
  assert.equal(campaignCanAdvanceArc(unresolved), false)
  assert.throws(
    () => advance(unresolved),
    (error) => error instanceof RulesValidationError && error.code === 'CAMPAIGN_ARC_NOT_READY',
  )
})

test('цепочка арок конечна и объявляется заранее владельцем', () => {
  const last = resolvedArc({ arcNumber: MAX_CAMPAIGN_ARCS })
  assert.equal(campaignCanAdvanceArc(last), false, 'потолок цепочки закрывает кампанию финалом')

  const state = resolvedArc()
  const chainOn = lifecycleEventForAction('chain_arcs', state, { actorId: 'owner' })
  assert.equal(chainOn.event_type, 'CampaignArcChainSet')
  assert.equal(chainOn.payload.enabled, true)
  const chained = applyGameEvent(state, chainOn)
  assert.equal(chained.campaignConcept.arc_chain, true)
  assert.equal(chained.mechanics.campaign_lifecycle.status, 'active', 'намерение не меняет статус кампании')

  const chainOff = lifecycleEventForAction('conclude_after_arc', chained, { actorId: 'owner' })
  assert.equal(applyGameEvent(chained, chainOff).campaignConcept.arc_chain, false)
})

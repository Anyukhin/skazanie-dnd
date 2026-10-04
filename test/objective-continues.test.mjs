// Сторож пункта 2 цели «Первый вечер без ведущего» (docs/playable-goal.md):
// приход туда, куда звала цель сцены, — шаг той же главы, а не брошенное дело.
//
// Плейтест 2026-10-02/03: цель «Добраться до смотровой дамбы, понять источник
// звона и не дать толпе открыть шлюзы», отряд голосует и приходит на дамбу — и
// получает «Главу 2» и «прежняя цель остаётся незавершённой». Решение владельца
// (вариант А, 2026-10-03): глава не растёт, остаток цели переходит в сцену.
import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { objectiveRemainder } from '../server/party-exit-intent.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { UNTRUSTED_DATA_END, UNTRUSTED_DATA_START } from '../server/security.mjs'

const OBJECTIVE = 'Добраться до смотровой дамбы, понять источник звона и не дать толпе открыть шлюзы.'
const REMAINDER = 'Понять источник звона и не дать толпе открыть шлюзы'

test('остаток цели: уходит только часть о самом приходе', () => {
  assert.equal(objectiveRemainder(OBJECTIVE, 'Смотровая дамба'), REMAINDER)
  assert.equal(objectiveRemainder('Добраться до смотровой дамбы', 'Смотровая дамба'), '', 'приход был всей целью')
  assert.equal(objectiveRemainder('Понять источник звона', 'Смотровая дамба'), null, 'цель это место не называет')
  assert.equal(objectiveRemainder('Найти в смотровой дамбе того, кто звонит', 'Смотровая дамба'), 'Найти в смотровой дамбе того, кто звонит', 'придаточное не режется, а место вплетено в задачу')
  assert.equal(
    objectiveRemainder('Проверить амбары, найти источник хора и решить, кому позволить открыть южные ворота.', 'Южные ворота'),
    'Проверить амбары, найти источник хора и решить, кому позволить открыть южные ворота',
    'у ворот ещё ничего не решено: часть без глагола движения приходом не исполняется',
  )
})

const veldburg = {
  sessionCode: 'GOAL-CONTINUES',
  scene: { title: 'Колокол под мутной водой', location: 'Вельдбург', objective: OBJECTIVE, turn: 3, cells: [] },
  adventure: { chapter: 1, currentHook: 'Девятый колокол зовёт тех, кто умеет читать старые карты', visitedLocations: ['Вельдбург'], history: [] },
}

test('архитектор без модели: приход к месту из цели продолжает ту же главу', async () => {
  const { sceneArgs } = await new SceneArchitectAgent().plan({ state: veldburg, decision: 'Уходим из «Вельдбург» и идём в «Смотровая дамба»', destinationHint: 'Смотровая дамба' })
  assert.equal(sceneArgs.objective_status, 'continued')
  assert.equal(sceneArgs.carry_unresolved, false, 'продолжение — не незакрытая нить')
  assert.equal(sceneArgs.objective, REMAINDER)
  assert.match(sceneArgs.title, /^Глава 1 · /u)
  assert.doesNotMatch(`${sceneArgs.transition} ${sceneArgs.outcome}`, /отступает|не закрыв|незаверш/u)
})

test('архитектор с моделью: «незавершённая цель» и «Глава 2» в ответе не проходят', async () => {
  let captured = null
  const architect = new SceneArchitectAgent({ llmClient: { completeJson: async (request) => {
    captured = request
    return {
      title: 'Глава 2 · У подножия Смотровой дамбы', location: 'Смотровая дамба',
      transition: 'Герои покидают Вельдбург и прибывают к Смотровой дамбе; прежняя цель остаётся незавершённой.',
      outcome: 'Цель брошена.', objective: 'Осмотреться у дамбы',
    }
  } } })
  const { sceneArgs } = await architect.plan({ state: veldburg, decision: 'Уходим из «Вельдбург» и идём в «Смотровая дамба»', destinationHint: 'Смотровая дамба' })
  assert.equal(sceneArgs.objective_status, 'continued')
  assert.equal(sceneArgs.objective, REMAINDER, 'цель — канонический остаток, а не пересказ модели')
  assert.match(sceneArgs.title, /^Глава 1 · /u)
  assert.doesNotMatch(sceneArgs.transition, /незаверш/u)
  assert.doesNotMatch(sceneArgs.outcome, /брошен/u)

  const user = captured.messages.find((message) => message.role === 'user').content
  const open = `${UNTRUSTED_DATA_START}:scene_planning>>>`
  const brief = JSON.parse(user.slice(user.indexOf(open) + open.length, user.indexOf(`${UNTRUSTED_DATA_END}:scene_planning>>>`)))
  assert.equal(brief.objective_continues, true)
  assert.equal(brief.objective_after_arrival, REMAINDER)
})

test('уход в место, которое цель не называет, по-прежнему оставляет нить незакрытой', async () => {
  const { sceneArgs } = await new SceneArchitectAgent().plan({ state: veldburg, decision: 'Уходим в Солёные Ворота', destinationHint: 'Солёные Ворота' })
  assert.equal(sceneArgs.objective_status, 'unresolved')
  assert.equal(sceneArgs.carry_unresolved, true)
})

function campaignAt(objective) {
  const state = normalizeCampaignState({
    sessionCode: 'GOAL-CONTINUES', activePlayerId: 'hero', partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Брам', hp: 10, maxHp: 10, inventory: [] }],
    scene: { title: 'Колокол под мутной водой', location: 'Вельдбург', mood: 'Тревога', objective, turn: 3, cells: [{ x: 1, y: 1, type: 'floor', revealed: true }] },
    adventure: { chapter: 1, currentHook: 'Девятый колокол зовёт', unresolvedThreads: [], visitedLocations: ['Вельдбург'], history: [] },
  })
  const quest = state.worldMemory.quests.find((entry) => entry.id === 'quest:chapter:1')
  quest.clock.current = 2
  // Стартовое задание кампании держит ту же формулировку цели первой сцены.
  state.worldMemory.quests.push({ ...structuredClone(quest), id: 'quest-opening', title: 'Девятый колокол', objectives: [objective, 'Узнать, кто подменил карту прилива'] })
  return state
}

function advance(state, sceneArgs) {
  return resolveCommands([{ command_type: 'AdvanceScene', command_id: 'advance-dam', scene_args: sceneArgs }], state,
    { diceService: new DiceService({ rng: new SequenceDiceRng([]) }), context: { isAdmin: true } })
}

test('переход с продолжением цели: та же глава, то же задание с теми же часами', async () => {
  const initial = campaignAt(OBJECTIVE)
  const { sceneArgs } = await new SceneArchitectAgent().plan({ state: initial, decision: 'Идём в «Смотровая дамба»', destinationHint: 'Смотровая дамба' })
  const result = advance(initial, sceneArgs)

  assert.equal(result.state.adventure.chapter, 1, 'глава не растёт')
  assert.equal(result.state.scene.objective, REMAINDER)
  assert.equal(result.state.adventure.history.at(-1).status, 'continued')
  assert.deepEqual(result.state.adventure.unresolvedThreads, [], 'продолжение не копится незакрытой нитью')

  const quests = result.state.worldMemory.quests
  assert.equal(quests.some((quest) => quest.id === 'quest:chapter:2'), false, 'второго задания не заводится')
  const quest = quests.find((entry) => entry.id === 'quest:chapter:1')
  assert.equal(quest.status, 'active')
  assert.deepEqual(quest.objectives, [REMAINDER])
  assert.equal(quest.clock.current, 2, 'часы задания сохраняются')
  const dam = result.state.worldMemory.entities.find((entity) => entity.name === 'Смотровая дамба')
  assert.ok(quest.entity_ids.includes(dam.id), 'находки на дамбе засчитываются этому заданию')
  assert.deepEqual(quests.find((entry) => entry.id === 'quest-opening').objectives, [REMAINDER, 'Узнать, кто подменил карту прилива'],
    'стартовое задание больше не зовёт туда, где отряд уже стоит; остальные его цели целы')

  assert.deepEqual(replayEvents(initial, result.events).worldMemory.quests, quests, 'replay даёт то же задание')
})

test('приход, который и был всей целью, закрывает её и открывает следующую главу', async () => {
  const initial = campaignAt('Добраться до смотровой дамбы')
  const { sceneArgs } = await new SceneArchitectAgent().plan({ state: initial, decision: 'Идём в «Смотровая дамба»', destinationHint: 'Смотровая дамба' })
  assert.equal(sceneArgs.objective_status, 'completed')
  const result = advance(initial, sceneArgs)
  assert.equal(result.state.adventure.chapter, 2)
  assert.equal(result.state.worldMemory.quests.find((entry) => entry.id === 'quest:chapter:1').status, 'completed')
})

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
import { objectiveRemainder, pendingOnwardTarget } from '../server/party-exit-intent.mjs'
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

// Плейтест 2026-10-04, SE-14: маршрут «Ночной район Ривермарк → Айрская башня →
// Дормар». В Дормаре цель по-прежнему звала «Продолжить путь из Айрская башня к
// «Дормар»» — и после перезагрузки: `objectiveRemainder` не узнавал в цели
// промежуточной точки глагола движения и отдавал её целиком как «остаток».
function routeCampaign() {
  return normalizeCampaignState({
    sessionCode: 'ROUTE-END', activePlayerId: 'hero', partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Лея', hp: 12, maxHp: 12, inventory: [] }],
    worldMap: {
      seed: 'route-end', name: 'Край', width: 1000, height: 640, currentLocationId: 'rivermark',
      regions: [{ id: 'r', name: 'Долина', x: 500, y: 320, radius: 300, biome: 'plains' }],
      locations: [
        { id: 'rivermark', name: 'Ночной район Ривермарк', kind: 'city', x: 200, y: 320, regionId: 'r', summary: '', known: true, visited: true },
        { id: 'air-tower', name: 'Айрская башня', kind: 'landmark', x: 450, y: 300, regionId: 'r', summary: '', known: true, visited: false },
        { id: 'dormar', name: 'Дормар', kind: 'village', x: 700, y: 330, regionId: 'r', summary: '', known: true, visited: false },
      ],
      routes: [
        { id: 'route-1', from: 'rivermark', to: 'air-tower', kind: 'road', distance: 2, danger: 'низкая', discovered: true },
        { id: 'route-2', from: 'air-tower', to: 'dormar', kind: 'road', distance: 2, danger: 'низкая', discovered: true },
      ],
    },
    scene: { title: 'Рынок после дождя', location: 'Ночной район Ривермарк', location_id: 'rivermark', mood: 'Тревога', objective: 'Найти пропавшего курьера', turn: 1, cells: [{ x: 1, y: 1, type: 'floor', revealed: true }] },
    adventure: { chapter: 1, currentHook: 'Курьер пропал после дождя', unresolvedThreads: [], visitedLocations: ['Ночной район Ривермарк'], history: [] },
  })
}

function advanceLeg(state, sceneArgs, commandId) {
  return resolveCommands([{ command_type: 'AdvanceScene', command_id: commandId, scene_args: sceneArgs }], state,
    { diceService: new DiceService({ rng: new SequenceDiceRng([]) }), context: { isAdmin: true } })
}

const TOWARD_DORMAR = { decision: 'Уходим из «Ночной район Ривермарк» и идём в «Дормар»', destinationHint: 'Дормар', destinationLocationId: 'dormar' }

test('составной маршрут: в конечной точке цель больше не зовёт туда же, и replay даёт то же', async () => {
  const architect = new SceneArchitectAgent()
  const start = routeCampaign()
  const first = await architect.plan({ state: start, ...TOWARD_DORMAR })
  assert.equal(first.sceneArgs.location_id, 'air-tower', 'дальний путь идёт по одному ребру за сцену')
  assert.equal(first.sceneArgs.objective, 'Продолжить путь из Айрская башня к «Дормар»')
  const atTower = advanceLeg(start, first.sceneArgs, 'leg-tower')
  assert.equal(pendingOnwardTarget(atTower.state.scene), 'Дормар', 'на промежуточной точке следующий пункт известен')

  const second = await architect.plan({ state: atTower.state, ...TOWARD_DORMAR, decision: 'Уходим из «Айрская башня» и идём в «Дормар»' })
  assert.equal(second.sceneArgs.location_id, 'dormar')
  assert.equal(second.sceneArgs.objective_status, 'completed', 'приход в конечную точку исполняет цель маршрута')
  assert.equal(second.sceneArgs.carry_unresolved, false)
  const atDormar = advanceLeg(atTower.state, second.sceneArgs, 'leg-dormar')
  const scene = atDormar.state.scene
  assert.equal(scene.location, 'Дормар')
  assert.doesNotMatch(scene.objective, /Продолжить путь[^»]*к «Дормар»/u)
  assert.equal(pendingOnwardTarget(scene), '')
  assert.equal(atDormar.state.adventure.history.at(-1).status, 'completed')
  assert.equal(atDormar.state.worldMemory.quests.find((quest) => quest.id === 'quest:chapter:2')?.status, 'completed',
    'задание транзитной главы закрыто приходом, а не висит активным')

  // Перезагрузка страницы читает состояние из потока событий.
  const replayed = replayEvents(start, [...atTower.events, ...atDormar.events])
  assert.equal(replayed.scene.location, 'Дормар')
  assert.equal(replayed.scene.objective, scene.objective)
  assert.deepEqual(replayed.worldMemory.quests, atDormar.state.worldMemory.quests)
})

test('составной маршрут при живой модели: цель транзита каноническая, в конечной точке модель не зовёт туда же', async () => {
  const start = routeCampaign()
  const transit = await new SceneArchitectAgent({ llmClient: { completeJson: async () => ({
    location: 'Айрская башня', objective: 'Осмотреть башню и найти ночлег',
  }) } }).plan({ state: start, ...TOWARD_DORMAR })
  assert.equal(transit.sceneArgs.location_id, 'air-tower')
  assert.equal(transit.sceneArgs.objective, 'Продолжить путь из Айрская башня к «Дормар»',
    'пересказ модели не стирает следующий пункт маршрута')
  const atTower = advanceLeg(start, transit.sceneArgs, 'leg-tower')

  const arrival = await new SceneArchitectAgent({ llmClient: { completeJson: async () => ({
    location: 'Дормар', objective: 'Продолжить путь из Айрская башня к «Дормар»',
  }) } }).plan({ state: atTower.state, ...TOWARD_DORMAR, decision: 'Уходим из «Айрская башня» и идём в «Дормар»' })
  assert.equal(arrival.sceneArgs.location_id, 'dormar')
  assert.equal(arrival.sceneArgs.objective_status, 'completed')
  assert.doesNotMatch(arrival.sceneArgs.objective, /Продолжить путь[^»]*к «Дормар»/u)
})

test('цель промежуточной точки к другому месту приходом сюда не исполняется', async () => {
  const start = routeCampaign()
  const first = await new SceneArchitectAgent().plan({ state: start, ...TOWARD_DORMAR })
  const atTower = advanceLeg(start, first.sceneArgs, 'leg-tower')
  // Отряд передумал и вернулся: Дормар так и не достигнут.
  const back = await new SceneArchitectAgent().plan({ state: atTower.state, decision: 'Уходим из «Айрская башня» и идём в «Ночной район Ривермарк»', destinationHint: 'Ночной район Ривермарк', destinationLocationId: 'rivermark' })
  assert.equal(back.sceneArgs.location_id, 'rivermark')
  assert.equal(back.sceneArgs.objective_status, 'unresolved')
})

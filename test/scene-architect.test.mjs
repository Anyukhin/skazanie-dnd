import assert from 'node:assert/strict'
import test from 'node:test'

import { createSceneTransition } from '../server/adventure-director.mjs'
import { generateDynamicSceneMap } from '../server/dynamic-map.mjs'
import { SceneArchitectAgent, buildDirectorPlanningBrief, interpretResolvedPartyDecision, knownDestinationsFrom } from '../server/scene-architect.mjs'
import { SCENE_COMMERCE_PLAN_VERSION, defaultSceneShopIntent } from '../server/scene-commerce.mjs'
import { UNTRUSTED_DATA_END, UNTRUSTED_DATA_START } from '../server/security.mjs'

// Сообщение картографу собирается через buildDataOnlyContext: полезная
// нагрузка лежит внутри блока UNTRUSTED_DATA и извлекается по его маркерам.
function untrustedPayload(content, section) {
  const open = `${UNTRUSTED_DATA_START}:${section}>>>`
  const close = `${UNTRUSTED_DATA_END}:${section}>>>`
  const start = content.indexOf(open)
  const end = content.indexOf(close)
  assert.ok(start >= 0 && end > start, `блок UNTRUSTED_DATA:${section} обязан присутствовать`)
  return JSON.parse(content.slice(start + open.length, end))
}

const archiveState = {
  sessionCode: 'LAB-ARCHIVE',
  scene: { title: 'Затопленный архив', location: 'Подземный архив Норвина', objective: 'Раскрыть тайну печати архивариуса', turn: 8, cells: [] },
  adventure: { chapter: 2, currentHook: 'Печать архивариуса указывает на скрытый зал', visitedLocations: ['Подземный архив Норвина'], history: [] },
  agentInteraction: {
    status: 'resolved', resolvedOptionId: 'city',
    options: [{ id: 'city', label: 'Уходим в город — отступаем и ищем другой путь' }, { id: 'stay', label: 'Остаёмся в архиве' }],
  },
}

test('картограф не объявляет выдуманную длительность перехода в прибытии', async () => {
  const architect = new SceneArchitectAgent({ llmClient: { completeJson: async () => ({
    location: 'Город', arrival: 'После нескольких дней пути отряд достигает городских ворот.',
  }) } })
  const planned = await architect.plan({ state: archiveState, decision: 'Уходим в город', destinationHint: 'Город' })
  assert.doesNotMatch(planned.sceneArgs.arrival, /нескольких дней/u)
  assert.match(planned.sceneArgs.arrival, /прибывает/u)
})

test('формулировка «Уходим в город» распознаётся по выбранной опции, а не по тексту инструкции', () => {
  const action = '[РЕШЕНИЕ ГРУППЫ] Уйти из архива в город?: Уходим в город. Если решила остаться — продолжи архив.'
  const result = interpretResolvedPartyDecision(action, archiveState)
  assert.equal(result.kind, 'move')
  assert.equal(result.destinationHint, 'город')
})

test('картограф без модели строит городскую карту и сохраняет печать как незавершённую нить', async () => {
  const decision = 'Уходим в город — отступаем и ищем другой путь, сохранив нить с печатью архивариуса'
  const architect = new SceneArchitectAgent()
  const planned = await architect.plan({ action: `[РЕШЕНИЕ ГРУППЫ] ${decision}`, state: archiveState, decision, destinationHint: 'город' })
  const transition = createSceneTransition(planned.sceneArgs, archiveState)

  assert.equal(planned.trace.agent, 'scene_architect')
  assert.equal(planned.sceneArgs.map.layout, 'streets')
  assert.equal(planned.sceneArgs.map.pattern, 'village')
  assert.equal(planned.sceneArgs.map.material, 'stone')
  assert.deepEqual(planned.shopIntent, defaultSceneShopIntent(planned.sceneArgs))
  assert.equal(planned.shopIntent.action, 'create')
  assert.equal(planned.shopIntent.settlement_type, 'city')
  assert.equal(transition.scene.location, 'Город')
  assert.equal(transition.scene.cells.length, transition.scene.map.width * transition.scene.map.height)
  assert.ok(transition.scene.map.width >= 26, 'городской переход не должен сжиматься до старого поля 17×11')
  assert.ok(transition.scene.cells.filter((cell) => cell.type === 'door').length >= 4,
    'городская карта обязана содержать двери домов')
  assert.match(transition.adventure.currentHook, /Печать архивариуса/u)
  assert.ok(transition.adventure.unresolvedThreads.includes(archiveState.adventure.currentHook))
  assert.equal(transition.adventure.history.at(-1).status, 'unresolved')
})

/** Карта мира с двумя соседями: деревня по дороге и пустошь по тропе. */
function brodWorldMap() {
  return {
    seed: 'brod', name: 'Край', width: 1000, height: 640, currentLocationId: 'tihiy-brod',
    regions: [{ id: 'r', name: 'Долина', x: 500, y: 320, radius: 300, biome: 'лес' }],
    locations: [
      { id: 'tihiy-brod', name: 'Тихий Брод', kind: 'village', x: 500, y: 360, regionId: 'r', summary: '', known: true, visited: true },
      { id: 'estwood', name: 'Эствуд', kind: 'village', x: 300, y: 280, regionId: 'r', summary: '', known: true, visited: false },
      { id: 'kerskaya', name: 'Керская пустошь', kind: 'wilds', x: 170, y: 450, regionId: 'r', summary: '', known: true, visited: false },
      { id: 'far', name: 'Дальний форт', kind: 'fortress', x: 900, y: 100, regionId: 'r', summary: '', known: true, visited: false },
    ],
    routes: [
      { id: 'route-1', from: 'tihiy-brod', to: 'estwood', kind: 'road', distance: 2, danger: 'низкая', discovered: true },
      { id: 'route-2', from: 'kerskaya', to: 'tihiy-brod', kind: 'trail', distance: 4, danger: 'средняя', discovered: true },
      { id: 'route-3', from: 'tihiy-brod', to: 'far', kind: 'road', distance: 9, danger: 'высокая', discovered: false },
      { id: 'route-4', from: 'estwood', to: 'far', kind: 'road', distance: 3, danger: 'высокая', discovered: true },
    ],
  }
}

const brodState = {
  sessionCode: 'BROD', worldMap: brodWorldMap(),
  scene: { title: 'Камень у брода', location: 'Тихий Брод', location_id: 'tihiy-brod', objective: 'Понять, что с камнем', turn: 3, cells: [] },
  adventure: { chapter: 1, currentHook: 'Зелёный камень', visitedLocations: ['Тихий Брод'], history: [] },
}

test('соседи по карте мира: открытые пути, сначала непосещённые, ближние раньше дальних', () => {
  const known = knownDestinationsFrom(brodState)
  assert.deepEqual(known.map((entry) => entry.name), ['Эствуд', 'Керская пустошь'], 'неоткрытый путь к форту не предлагается')
  assert.deepEqual(known.map((entry) => entry.kind), ['village', 'wilds'])
  assert.deepEqual(known.map((entry) => entry.days), [2, 4])
  assert.equal(knownDestinationsFrom({ scene: { location: 'Нигде' } }).length, 0)
  // Текущая точка ищется и по названию сцены, когда идентификатора в карте нет.
  const byName = knownDestinationsFrom({ ...brodState, worldMap: { ...brodWorldMap(), currentLocationId: '' } })
  assert.equal(byName[0]?.name, 'Эствуд')
})

test('уход без названного места ведёт к соседу по карте мира, а не в «Окрестности»', async () => {
  // Так выглядел уход в живой кампании: «покинуть локацию» без цели давал
  // «Окрестности Тихий Брод», второй уход — «Окрестности Окрестности Тихий
  // Брод», и оба раза то же поле. Карта мира с соседними деревнями стояла без дела.
  const architect = new SceneArchitectAgent()
  const planned = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Покинуть «Тихий Брод»', state: brodState, decision: 'Покинуть «Тихий Брод»', destinationHint: '',
  })
  assert.equal(planned.sceneArgs.location, 'Эствуд')
  assert.equal(planned.sceneArgs.map.layout, 'streets', 'деревня по карте мира обязана получить улицы')
  assert.equal(planned.sceneArgs.map.pattern, 'village')
  assert.match(planned.sceneArgs.arrival, /Эствуд/u)
  const transition = createSceneTransition(planned.sceneArgs, brodState)
  assert.equal(transition.scene.location_id, 'estwood')
  assert.ok(transition.scene.cells.some((cell) => cell.type === 'door'), 'в деревне по карте мира нет домов')

  // Названное игроками место остаётся главнее соседей.
  const hinted = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Уходим в Керскую пустошь', state: brodState, decision: 'Уходим в Керскую пустошь', destinationHint: 'Керская пустошь',
  })
  assert.equal(hinted.sceneArgs.location, 'Керская пустошь')
  assert.equal(hinted.sceneArgs.map.pattern, 'natural', 'пустошь по карте мира — дикая местность')
  assert.equal(hinted.sceneArgs.map.material, 'grass')

  // Название исходной точки входит в служебный текст глобальной карты. Оно не
  // должно перекрасить непрозрачно названную деревню в мост из-за слова «Брод».
  const exactVillage = await architect.plan({
    action: '[ГЛОБАЛЬНАЯ КАРТА] Отряд предлагает отправиться из «Тихий Брод» в «Эствуд». Выбранный путь: Тихий Брод → Эствуд.',
    state: brodState,
    decision: 'Отправиться из «Тихий Брод» в «Эствуд»',
    destinationHint: 'Эствуд',
  })
  assert.equal(exactVillage.sceneArgs.location, 'Эствуд')
  assert.equal(exactVillage.sceneArgs.location_id, 'estwood')
  assert.equal(exactVillage.sceneArgs.map.layout, 'streets')
  assert.equal(exactVillage.sceneArgs.map.pattern, 'village')
})

test('авторитетный ID назначения побеждает расходящееся имя, а неизвестный ID сохраняет legacy', async () => {
  const architect = new SceneArchitectAgent()
  const byId = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Идём в Керскую пустошь',
    state: brodState,
    decision: 'Идём в Керскую пустошь',
    destinationHint: 'Керская пустошь',
    destinationLocationId: 'estwood',
  })
  assert.equal(byId.sceneArgs.location, 'Эствуд')
  assert.equal(byId.sceneArgs.location_id, 'estwood')
  assert.equal(byId.sceneArgs.map.pattern, 'village')

  const legacy = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Идём в Керскую пустошь',
    state: brodState,
    decision: 'Идём в Керскую пустошь',
    destinationHint: 'Керская пустошь',
    destinationLocationId: 'missing-location',
  })
  assert.equal(legacy.sceneArgs.location, 'Керская пустошь')
  assert.equal(legacy.sceneArgs.location_id, 'kerskaya')
})

test('ID различает две известные локации с одинаковым названием и без модели, и после ответа модели', async () => {
  const duplicateMap = brodWorldMap()
  duplicateMap.locations.push({
    id: 'estwood-south', name: 'Эствуд', kind: 'wilds', x: 650, y: 500,
    regionId: 'r', summary: 'Южная окраина', known: true, visited: false,
  })
  duplicateMap.routes.push({
    id: 'route-south', from: 'tihiy-brod', to: 'estwood-south', kind: 'trail',
    distance: 3, danger: 'средняя', discovered: true,
  })
  const state = { ...brodState, worldMap: duplicateMap }
  const input = {
    action: '[РЕШЕНИЕ ГРУППЫ] Идём в Эствуд', state, decision: 'Идём в Эствуд',
    destinationHint: 'Эствуд', destinationLocationId: 'estwood-south',
  }

  const fallback = await new SceneArchitectAgent().plan(input)
  assert.equal(fallback.sceneArgs.location_id, 'estwood-south')
  assert.equal(fallback.sceneArgs.map.pattern, 'natural', 'вид выбранного дубля берётся по его ID')

  const modeled = await new SceneArchitectAgent({ llmClient: {
    async completeJson() { return { location: 'Эствуд', map: { layout: 'streets', pattern: 'village' } } },
  } }).plan(input)
  assert.equal(modeled.sceneArgs.location_id, 'estwood-south')
  assert.equal(modeled.sceneArgs.map.pattern, 'natural')
})

test('без карты мира уход не вкладывает «Окрестности» друг в друга', async () => {
  const architect = new SceneArchitectAgent()
  const first = await architect.plan({ action: '[РЕШЕНИЕ ГРУППЫ] Уходим отсюда', state: archiveState, decision: 'Уходим отсюда', destinationHint: '' })
  assert.equal(first.sceneArgs.location, 'Окрестности Подземный архив Норвина')
  const secondState = { ...archiveState, scene: { ...archiveState.scene, location: first.sceneArgs.location } }
  const second = await architect.plan({ action: '[РЕШЕНИЕ ГРУППЫ] Уходим отсюда', state: secondState, decision: 'Уходим отсюда', destinationHint: '' })
  assert.equal(second.sceneArgs.location, 'Тракт за Подземный архив Норвина')
  assert.doesNotMatch(second.sceneArgs.location, /Окрестности Окрестности/u)
})

test('картограф получает соседей по карте мира в planning brief', async () => {
  const brief = buildDirectorPlanningBrief(brodState)
  assert.deepEqual(brief.known_destinations.map((entry) => entry.name), ['Эствуд', 'Керская пустошь'])
  assert.deepEqual(Object.keys(brief.known_destinations[0]).sort(), ['biome', 'danger', 'days', 'kind', 'name', 'visited'])
  let capturedRequest = null
  const architect = new SceneArchitectAgent({ llmClient: { async completeJson(request) { capturedRequest = request; return {} } } })
  await architect.plan({ action: '[РЕШЕНИЕ ГРУППЫ] Покинуть «Тихий Брод»', state: brodState, decision: 'Покинуть «Тихий Брод»', destinationHint: '' })
  const context = untrustedPayload(capturedRequest.messages[1].content, 'scene_planning')
  assert.equal(context.known_destinations[0].name, 'Эствуд')
  assert.match(capturedRequest.messages[0].content, /known_destinations/u)

  const enriched = structuredClone(brodState)
  enriched.worldMap.locations[1].summary = 'Деревня у судоходной реки.'
  enriched.worldMap.locations[1].history = 'Здесь стоят старые речные пристани.'
  const enrichedBrief = buildDirectorPlanningBrief(enriched)
  assert.equal(enrichedBrief.known_destinations[0].summary, 'Деревня у судоходной реки.')
  assert.equal(enrichedBrief.known_destinations[0].history, 'Здесь стоят старые речные пристани.')
  assert.equal(enrichedBrief.known_destinations[0].biome, 'лес')
})

test('известное назначение и его карта остаются серверными после ответа модели', async () => {
  const architect = new SceneArchitectAgent({ llmClient: { model: 'fake-cartographer', async completeJson() {
    return {
      title: 'Ложный склеп',
      location: 'Керская пустошь',
      theme: 'древний склеп',
      objective_status: 'completed',
      carry_unresolved: false,
      map: { layout: 'cavern', scale: 'room', pattern: 'crypt', material: 'stone', width: 7, height: 7 },
    }
  } } })
  const planned = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Покинуть «Тихий Брод»',
    state: brodState,
    decision: 'Покинуть «Тихий Брод»',
    destinationHint: '',
  })

  assert.equal(planned.trace.mode, 'model')
  assert.equal(planned.sceneArgs.location, 'Керская пустошь')
  assert.equal(planned.sceneArgs.location_id, 'kerskaya')
  assert.equal(planned.sceneArgs.theme, 'дикая местность')
  assert.equal(planned.sceneArgs.map.layout, 'winding')
  assert.equal(planned.sceneArgs.map.pattern, 'natural')
  assert.equal(planned.sceneArgs.map.material, 'grass')
  assert.equal(planned.sceneArgs.objective_status, 'unresolved')
  assert.equal(planned.sceneArgs.carry_unresolved, true)
  assert.equal(createSceneTransition(planned.sceneArgs, brodState).scene.location_id, 'kerskaya')

  const abandoned = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Отказываемся от задания и уходим в Керскую пустошь',
    state: brodState,
    decision: 'Отказываемся от задания и уходим в Керскую пустошь',
    destinationHint: 'Керская пустошь',
    abandonsQuest: true,
  })
  assert.equal(abandoned.sceneArgs.objective_status, 'abandoned')
  assert.equal(abandoned.sceneArgs.carry_unresolved, false)
})

test('известное назначение сохраняет bounded design модели, но канонический тип места сильнее', async () => {
  const architect = new SceneArchitectAgent({ llmClient: { async completeJson() {
    return {
      location: 'Эствуд',
      map: {
        layout: 'cavern', scale: 'room', pattern: 'crypt', material: 'earth',
        width: 48, height: 40, openness: 0.74, water: 0.18, featureCount: 12,
        design: { topology: 'market', density: 'dense', forged: 'ignored' },
      },
    }
  } } })
  const planned = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Идём в Эствуд', state: brodState,
    decision: 'Идём в Эствуд', destinationHint: 'Эствуд', destinationLocationId: 'estwood',
  })

  assert.equal(planned.sceneArgs.location_id, 'estwood')
  assert.equal(planned.sceneArgs.map.layout, 'streets')
  assert.equal(planned.sceneArgs.map.pattern, 'village')
  assert.ok(planned.sceneArgs.map.width >= 24 && planned.sceneArgs.map.width <= 40)
  assert.ok(planned.sceneArgs.map.design)
  assert.equal(Object.hasOwn(planned.sceneArgs.map.design, 'forged'), false)
  assert.equal(planned.sceneArgs.map.design.density, 'dense')
})

test('описание порта и речного города влияет на design, а поселения не получают один размер', async () => {
  const state = structuredClone(brodState)
  state.worldMap.locations.push(
    { id: 'port', name: 'Мормар', kind: 'port', x: 650, y: 250, regionId: 'r', summary: 'Портовый город на реке.', history: 'Пристани тянутся вдоль берега.', known: true, visited: false },
    { id: 'city', name: 'Риверберг', kind: 'city', x: 700, y: 420, regionId: 'r', summary: 'Город у реки.', history: 'Через город проходит судоходная река.', known: true, visited: false },
  )
  state.worldMap.routes.push(
    { id: 'route-port', from: 'tihiy-brod', to: 'port', kind: 'river', distance: 3, danger: 'средняя', discovered: true },
    { id: 'route-city', from: 'tihiy-brod', to: 'city', kind: 'river', distance: 4, danger: 'средняя', discovered: true },
  )
  const architect = new SceneArchitectAgent()
  const port = await architect.plan({ state, action: 'Идём в Мормар', decision: 'Идём в Мормар', destinationHint: 'Мормар', destinationLocationId: 'port' })
  const city = await architect.plan({ state, action: 'Идём в Риверберг', decision: 'Идём в Риверберг', destinationHint: 'Риверберг', destinationLocationId: 'city' })

  assert.ok(['harbor', 'river'].includes(port.sceneArgs.map.design?.topology))
  assert.ok(['harbor', 'river'].includes(city.sceneArgs.map.design?.topology))
  assert.ok(port.sceneArgs.map.width >= 26)
  assert.ok(city.sceneArgs.map.width >= 26)
  assert.notEqual(port.sceneArgs.map.width, 24, 'порт не должен схлопываться в размер деревни')
})

test('модель не может заменить известного соседа выдуманной промежуточной сценой', async () => {
  const architect = new SceneArchitectAgent({ llmClient: { model: 'fake-cartographer', async completeJson() {
    return {
      title: 'Окрестности окрестностей',
      location: 'Окрестности Тихого Брода',
      theme: 'дорога',
      map: { layout: 'winding', pattern: 'natural', material: 'earth' },
      shop_intent: { action: 'create', settlement_type: 'city', theme: 'arms', budget_cp: 100_000 },
    }
  } } })
  const planned = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Покинуть «Тихий Брод»',
    state: brodState,
    decision: 'Покинуть «Тихий Брод»',
    destinationHint: '',
  })

  assert.equal(planned.trace.mode, 'model', 'генерация была и должна учитываться в расходе')
  assert.equal(planned.trace.constraint, 'known_destination_fallback')
  assert.equal(planned.sceneArgs.location, 'Эствуд')
  assert.equal(planned.sceneArgs.location_id, 'estwood')
  assert.equal(planned.sceneArgs.map.layout, 'streets')
  assert.deepEqual(planned.shopIntent, defaultSceneShopIntent(planned.sceneArgs))
})

test('дальний маршрут исполняется по одному сегменту и не создаёт ложную прямую дорогу', async () => {
  const planned = await new SceneArchitectAgent().plan({
    action: '[ГЛОБАЛЬНАЯ КАРТА] Отряд предлагает отправиться из «Тихий Брод» в «Дальний форт». Выбранный путь: Тихий Брод → Эствуд → Дальний форт.',
    state: brodState,
    decision: 'Отправиться из «Тихий Брод» в «Дальний форт» через Эствуд',
    destinationHint: 'Керская пустошь',
    destinationLocationId: 'far',
  })
  assert.equal(planned.sceneArgs.location, 'Эствуд')
  assert.equal(planned.sceneArgs.location_id, 'estwood')
  assert.match(planned.sceneArgs.objective, /Дальний форт/u)

  const transition = createSceneTransition(planned.sceneArgs, brodState)
  assert.equal(transition.worldMap.currentLocationId, 'estwood')
  assert.equal(transition.worldMap.routes.find((route) => route.id === 'route-3')?.discovered, false)
  assert.equal(transition.worldMap.routes.filter((route) => (
    new Set([route.from, route.to]).has('tihiy-brod') && new Set([route.from, route.to]).has('far')
  )).length, 1, 'переход через Эствуд не должен дорисовать второе ребро Тихий Брод → Дальний форт')
})

test('названное неизвестное место не может быть переименовано моделью', async () => {
  const architect = new SceneArchitectAgent({ llmClient: { model: 'fake-cartographer', async completeJson() {
    return { location: 'Совсем другая долина', title: 'Подмена направления', map: { layout: 'open', pattern: 'natural' } }
  } } })
  const planned = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Идём в Долину Серебряных Рек',
    state: archiveState,
    decision: 'Идём в Долину Серебряных Рек',
    destinationHint: 'Долина Серебряных Рек',
  })
  assert.equal(planned.trace.mode, 'model')
  assert.equal(planned.trace.constraint, 'known_destination_fallback')
  assert.equal(planned.sceneArgs.location, 'Долина Серебряных Рек')
})

test('детерминированный fallback не создаёт стационарную лавку в дикой местности', async () => {
  const architect = new SceneArchitectAgent()
  const planned = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Уходим в лес',
    state: archiveState,
    decision: 'Уходим в лес',
    destinationHint: 'лес',
  })

  assert.equal(planned.sceneArgs.map.layout, 'winding')
  assert.equal(planned.shopIntent.action, 'none')
  assert.equal(planned.shopIntent.settlement_type, 'traveling')
  assert.equal(planned.shopIntent.theme, 'provisions')
})

test('явный лес назначения важнее упоминания исходного города в решении', async () => {
  const architect = new SceneArchitectAgent()
  const planned = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Уходим из «Большой город Норвин» и идём в Серую чащу',
    state: { ...archiveState, scene: { ...archiveState.scene, location: 'Большой город Норвин' } },
    decision: 'Уходим из «Большой город Норвин» и идём в Серую чащу',
    destinationHint: 'Серую чащу',
  })

  assert.equal(planned.sceneArgs.location, 'Серую чащу')
  assert.equal(planned.sceneArgs.map.layout, 'winding')
  assert.equal(planned.shopIntent.action, 'none')
})

test('модель может предложить только ограниченный commerce intent для нормализованной сцены', async () => {
  const llmClient = {
    model: 'fake-cartographer',
    async completeJson() {
      return {
        title: 'Ремесленный квартал',
        location: 'Большой город Норвин',
        theme: 'городские улицы и кузницы',
        map: { layout: 'streets', width: 19, height: 13 },
        shop_intent: {
          action: 'create',
          settlement_type: 'city',
          theme: 'arms',
          budget_cp: 75_000,
          reason: 'В квартале действует оружейный рынок.',
        },
      }
    },
  }
  const planned = await new SceneArchitectAgent({ llmClient }).plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Идём в город',
    state: archiveState,
    decision: 'Идём в город',
    destinationHint: 'город',
  })

  assert.equal(planned.trace.mode, 'model')
  assert.equal(planned.sceneArgs.location, 'Большой город Норвин')
  assert.deepEqual(planned.shopIntent, {
    version: SCENE_COMMERCE_PLAN_VERSION,
    action: 'create',
    settlement_type: 'city',
    theme: 'arms',
    budget_cp: 75_000,
    reason: 'В квартале действует оружейный рынок.',
  })
})

test('опасные поля commerce proposal целиком откатываются к policy фактической сцены', async () => {
  const llmClient = {
    async completeJson() {
      return {
        title: 'Городская площадь',
        location: 'Город Норвин',
        theme: 'городские улицы',
        map: { layout: 'streets' },
        shop_intent: {
          action: 'none',
          settlement_type: 'village',
          theme: 'healing',
          budget_cp: 900_000,
          reason: 'Попытка подменить торговую policy.',
          stock: [{ catalog_id: 'custom:artifact', base_price_cp: 1 }],
        },
      }
    },
  }
  const planned = await new SceneArchitectAgent({ llmClient }).plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Идём в город',
    state: archiveState,
    decision: 'Идём в город',
    destinationHint: 'город',
  })

  assert.deepEqual(planned.shopIntent, defaultSceneShopIntent(planned.sceneArgs))
})

// Отказ модели — рабочее состояние стола, а не исключительная ситуация: таймаут
// провайдера, обрыв соединения, невалидный JSON. Ветка `catch` обязана вернуть ту
// же сцену, что и запуск вовсе без модели, иначе партия остаётся без карты
// посреди перехода. До этого сторожа ветку держал сетевой флейк API-тестов: они
// поднимали сервер с выдуманным ключом, поход в настоящего провайдера падал, и
// покрытие было побочным продуктом аварии — вместе с ней оно и ушло.
test('падение модели уводит Архитектора в ту же детерминированную сцену, что и запуск без модели', async () => {
  const request = {
    action: '[РЕШЕНИЕ ГРУППЫ] Уходим в город',
    state: archiveState,
    decision: 'Уходим в город',
    destinationHint: 'город',
  }
  const offline = await new SceneArchitectAgent().plan(request)
  const failed = await new SceneArchitectAgent({
    llmClient: { model: 'fake-cartographer', async completeJson() { throw new Error('LLM_TIMEOUT') } },
  }).plan(request)

  assert.equal(failed.trace.agent, 'scene_architect')
  assert.equal(failed.trace.mode, 'deterministic-fallback')
  assert.equal(failed.trace.reason, 'LLM_TIMEOUT')
  assert.notEqual(failed.trace.reason, offline.trace.reason,
    'трейс обязан отличать отказ модели от её отсутствия — это разные аварии')
  assert.deepEqual(failed.sceneArgs, offline.sceneArgs)
  assert.deepEqual(failed.shopIntent, defaultSceneShopIntent(failed.sceneArgs))
  assert.equal(failed.sceneArgs.map.layout, 'streets')
  const failedTransition = createSceneTransition(failed.sceneArgs, archiveState)
  assert.equal(failedTransition.scene.cells.length, failedTransition.scene.map.width * failedTransition.scene.map.height)
  assert.ok(failedTransition.scene.map.width >= 26)

  // Провайдер может оборвать соединение и не Error-ом. Причина тогда неизвестна,
  // но сцена обязана остаться той же.
  const rejected = await new SceneArchitectAgent({
    llmClient: { completeJson: () => Promise.reject('провайдер оборвал соединение') },
  }).plan(request)
  assert.equal(rejected.trace.mode, 'deterministic-fallback')
  assert.equal(rejected.trace.reason, 'unknown error')
  assert.deepEqual(rejected.sceneArgs, offline.sceneArgs)
})

test('Scene Architect получает только public planning brief без клеток и private memory', async () => {
  let capturedRequest = null
  const llmClient = {
    async completeJson(request) {
      capturedRequest = request
      return {}
    },
  }
  const privateState = structuredClone(archiveState)
  privateState.scene.cells = [{
    x: 7, y: 4, type: 'floor', revealed: false,
    hidden_information: 'CELL-HIDDEN-SECRET', gm_only: 'CELL-GM-SECRET', label: 'SECRET-CELL-LABEL',
  }]
  privateState.scene.gm_only = { trap: 'SCENE-GM-SECRET' }
  privateState.scene.hidden_information = { exit: 'SCENE-HIDDEN-SECRET' }
  privateState.adventure.history = [{
    chapter: 1, title: 'Публичная глава', location: 'Башня', objective: 'Войти', outcome: 'Вход найден',
    gm_only: 'HISTORY-GM-SECRET', hidden_information: 'HISTORY-HIDDEN-SECRET',
  }]
  privateState.adventure.gm_only = { villain: 'ADVENTURE-GM-SECRET' }
  privateState.adventure.hidden_information = { route: 'ADVENTURE-HIDDEN-SECRET' }
  privateState.adventure.npc_private = { archivist: 'NPC-PRIVATE-SECRET' }
  privateState.adventure.private_notes = 'PRIVATE-NOTES-SECRET'

  const planned = await new SceneArchitectAgent({ llmClient }).plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Идём в город',
    state: privateState,
    decision: 'Идём в город',
    destinationHint: 'город',
  })

  assert.ok(capturedRequest)
  const context = untrustedPayload(capturedRequest.messages[1].content, 'scene_planning')
  assert.equal(Object.hasOwn(context.current_scene, 'cells'), false)
  assert.equal(Object.hasOwn(context.current_scene, 'gm_only'), false)
  assert.equal(Object.hasOwn(context.adventure_memory, 'gm_only'), false)
  assert.deepEqual(Object.keys(context.adventure_memory).sort(), [
    'chapter', 'currentHook', 'history', 'unresolvedThreads', 'visitedLocationIds', 'visitedLocations',
  ])
  const externalPayload = JSON.stringify(context)
  for (const secret of [
    'CELL-HIDDEN-SECRET', 'CELL-GM-SECRET', 'SECRET-CELL-LABEL', 'SCENE-GM-SECRET',
    'SCENE-HIDDEN-SECRET', 'HISTORY-GM-SECRET', 'HISTORY-HIDDEN-SECRET',
    'ADVENTURE-GM-SECRET', 'ADVENTURE-HIDDEN-SECRET', 'NPC-PRIVATE-SECRET', 'PRIVATE-NOTES-SECRET',
  ]) assert.doesNotMatch(externalPayload, new RegExp(secret, 'u'))
  assert.doesNotMatch(JSON.stringify(planned.sceneArgs), /SECRET/u)
})

test('параметры картографа дают детерминированные карты разных размеров', () => {
  const input = { seed: 'city:free-choice', theme: 'городские улицы', layout: 'streets', width: 19, height: 13, openness: 0.7, featureCount: 8 }
  const first = generateDynamicSceneMap(input)
  assert.deepEqual(first, generateDynamicSceneMap(input))
  assert.equal(first.length, 19 * 13)
  assert.equal(first.find((cell) => cell.x === 1 && cell.y === 6)?.type, 'floor')
  assert.equal(first.filter((cell) => cell.feature).length, 8)
  assert.ok(first.every((cell) => cell.material === 'stone' && Number.isInteger(cell.variant) && typeof cell.edge_mask === 'string'))
})

test('семантический реквизит соответствует дому, пещере и лесу', () => {
  const house = generateDynamicSceneMap({
    seed: 'semantic:house', theme: 'жилой дом', layout: 'rooms', pattern: 'small-room', material: 'wood',
    width: 9, height: 7, openness: 0.82, water: 0, featureCount: 9,
  })
  const cave = generateDynamicSceneMap({
    seed: 'semantic:cave', theme: 'подземная пещера', layout: 'cavern', pattern: 'cave-cluster', material: 'earth',
    width: 15, height: 11, openness: 0.64, water: 0.08, featureCount: 10,
  })
  const forest = generateDynamicSceneMap({
    seed: 'semantic:forest', theme: 'лесная чаща', layout: 'winding', pattern: 'natural', material: 'grass',
    width: 15, height: 11, openness: 0.64, water: 0.04, featureCount: 10,
  })

  const houseFeatures = new Set(house.map((cell) => cell.feature).filter(Boolean))
  const caveFeatures = new Set(cave.map((cell) => cell.feature).filter(Boolean))
  const forestFeatures = new Set(forest.map((cell) => cell.feature).filter(Boolean))
  assert.ok(['bed', 'table', 'chair', 'fireplace'].every((feature) => houseFeatures.has(feature)))
  assert.ok(['rock', 'mushroom', 'bones'].every((feature) => caveFeatures.has(feature)))
  assert.ok(['tree', 'bush', 'rock'].every((feature) => forestFeatures.has(feature)))
  assert.deepEqual(new Set(forest.filter((cell) => cell.type === 'floor').map((cell) => cell.material)), new Set(['grass', 'earth']))
  assert.ok([...house, ...cave, ...forest].filter((cell) => cell.feature).every((cell) => cell.type === 'floor'))
})

test('масштаб крепости не может быть сжат моделью до размера маленькой комнаты', async () => {
  const architect = new SceneArchitectAgent({ llmClient: { async completeJson() {
    return {
      title: 'Цитадель Бури', location: 'Цитадель Бури', theme: 'горная крепость',
      map: { layout: 'rooms', scale: 'stronghold', pattern: 'keep', material: 'stone', width: 7, height: 7 },
    }
  } } })
  const planned = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Идём в крепость', state: archiveState,
    decision: 'Идём в крепость', destinationHint: 'крепость',
  })
  assert.equal(planned.sceneArgs.map.scale, 'stronghold')
  assert.equal(planned.sceneArgs.map.pattern, 'keep')
  assert.equal(planned.sceneArgs.map.width, 19)
  assert.equal(planned.sceneArgs.map.height, 13)
  const transition = createSceneTransition(planned.sceneArgs, archiveState)
  assert.ok(transition.scene.map.width >= 19 && transition.scene.map.height >= 16,
    'Полная крепость не должна сжиматься до старого комнатного минимума')
  assert.equal(transition.scene.map.generator.id, 'building-with-yard')
  assert.equal(transition.scene.map.tilesetId, 'building')
  assert.ok(transition.scene.map.zones.some((zone) => zone.id === 'hall' && zone.kind === 'interior'),
    'процедурное здание обязано иметь внутренний зал')
  assert.ok(transition.scene.map.zones.filter((zone) => zone.kind === 'interior').length >= 3,
    'крепость должна содержать несколько связанных помещений')
  assert.ok(transition.scene.map.doors.length >= 2, 'процедурное здание обязано иметь проходы между помещениями')
  assert.ok(transition.scene.map.props.length > 0, 'процедурное здание обязано иметь реквизит')
  assert.ok(transition.scene.cells.some((cell) => cell.type === 'door'),
    'каменная крепость обязана получить структурированную планировку с проходами')
})

test('органические шаблоны создают разные неровные силуэты без недостижимых проходов', () => {
  const formats = [
    { layout: 'cavern', pattern: 'cave-cluster' },
    { layout: 'ruins', pattern: 'courtyard' },
    { layout: 'radial', pattern: 'great-hall' },
    { layout: 'winding', pattern: 'natural' },
    { layout: 'winding', pattern: 'bridge' },
  ]
  const maps = formats.map(({ layout, pattern }) => generateDynamicSceneMap({
    seed: `shape:${layout}:${pattern}`, theme: layout === 'cavern' ? 'подземная пещера' : layout, layout, pattern,
    width: 17, height: 13, openness: 0.64, featureCount: 6,
  }))

  for (const cells of maps) {
    assert.ok(cells.length < 17 * 13, 'неровный силуэт должен содержать пустоты за границей карты')
    const byPosition = new Map(cells.map((cell) => [`${cell.x},${cell.y}`, cell]))
    const entrance = byPosition.get('1,6')
    assert.equal(entrance?.type, 'floor')
    const reached = new Set(['1,6'])
    const queue = [entrance]
    for (let index = 0; index < queue.length; index += 1) {
      const cell = queue[index]
      for (const [x, y] of [[cell.x + 1, cell.y], [cell.x - 1, cell.y], [cell.x, cell.y + 1], [cell.x, cell.y - 1]]) {
        const key = `${x},${y}`
        const next = byPosition.get(key)
        if (!next || !['floor', 'door'].includes(next.type) || reached.has(key)) continue
        reached.add(key)
        queue.push(next)
      }
    }
    const walkable = cells.filter((cell) => ['floor', 'door'].includes(cell.type))
    assert.equal(reached.size, walkable.length)
    assert.equal(cells.filter((cell) => cell.feature).length, 6)
  }

  assert.equal(new Set(maps.map((cells) => cells.map((cell) => `${cell.x},${cell.y}`).join('|'))).size, formats.length)
})

test('цель новой сцены — название в кавычках и обрезка по слову, а не «в Пепельная застава … пох»', async () => {
  // Прогон Асстохана (2026-10-05): цель «Найти в Пепельная застава другой путь
  // к разгадке: … с забытым пох» — название без склонения и обрыв на полуслове.
  const hook = 'Саргат разоряет равнины и собирает сведения о героях, а три свежих донесения связывают его охоту с забытым походом самого короля'
  const state = { ...brodState, adventure: { ...(brodState.adventure ?? {}), currentHook: hook } }
  const planned = await new SceneArchitectAgent().plan({ action: '[РЕШЕНИЕ ГРУППЫ] Покинуть «Тихий Брод»', state, decision: 'Покинуть «Тихий Брод»', destinationHint: '' })
  const objective = planned.sceneArgs.objective
  assert.match(objective, /«Эствуд»/u, objective)
  assert.ok(objective.length <= 160, objective)
  assert.match(objective, /(?:[.!?…»]|[а-яё])$/iu)
  assert.doesNotMatch(objective, /\s\p{L}{1,3}$/u, `обрыв на полуслове: ${objective}`)
})

// ---------------------------------------------------------------------------
// Маяк — здание, а прибытие сверяется с картой (живой замер 2026-10-10)
// ---------------------------------------------------------------------------

function harbourState(lighthouse = { name: 'Старый маяк', summary: 'Заброшенная башня на скале над гаванью; огонь в ней снова загорается по ночам.' }) {
  return {
    sessionCode: 'LIGHTHOUSE', campaign: 'Серый Причал',
    campaignConcept: { premise: 'Туманный порт Серый Причал. На скале над гаванью — заброшенный маяк.' },
    worldMap: {
      seed: 'lighthouse-seed', currentLocationId: 'port',
      regions: [{ id: 'coast', name: 'Побережье', biome: 'coast', x: 500, y: 300, radius: 300 }],
      locations: [
        { id: 'port', name: 'Серый Причал', kind: 'port', x: 500, y: 300, regionId: 'coast', known: true, visited: true, summary: 'Туманный порт.' },
        { id: 'lighthouse', kind: 'landmark', x: 640, y: 220, regionId: 'coast', known: true, visited: false, ...lighthouse },
      ],
      routes: [{ id: 'route-lighthouse', from: 'port', to: 'lighthouse', kind: 'road', distance: 1, danger: 'средняя', discovered: true }],
    },
    scene: { title: 'Ржавый якорь', location: 'Серый Причал', location_id: 'port', objective: 'Узнать, откуда пришёл баркас', turn: 3, cells: [] },
    adventure: { chapter: 1, currentHook: 'Пустой баркас', visitedLocations: ['Серый Причал'], history: [] },
  }
}

const lighthouseModel = {
  model: 'fake',
  async completeJson() {
    return {
      location: 'Старый маяк', title: 'Маяк над гаванью', theme: 'берег реки',
      transition: 'Отряд покидает таверну и по скользкой тропе поднимается к маяку.',
      arrival: 'Над обрывом высится башня маяка. Тяжёлая дверь приоткрыта. Через реку перекинут старый мост. Вдали у причала качаются лодки.',
      map: { layout: 'winding', pattern: 'bridge', width: 30, height: 22, design: { topology: 'river' } },
    }
  },
}

test('«Старый маяк» над гаванью — башня с дверью и помещениями, а не берег реки с мостом', async () => {
  const state = harbourState()
  for (const llmClient of [null, lighthouseModel]) {
    const plan = await new SceneArchitectAgent({ llmClient }).plan({
      action: 'Идём к старому маяку', decision: 'Идём к старому маяку',
      destinationHint: 'Старый маяк', destinationLocationId: 'lighthouse', state,
    })
    const label = plan.trace.mode
    assert.equal(plan.sceneArgs.location, 'Старый маяк', label)
    assert.notEqual(plan.sceneArgs.map.pattern, 'bridge', label)
    assert.notEqual(plan.sceneArgs.map.design?.topology, 'river', label)
    assert.doesNotMatch(plan.sceneArgs.theme, /рек|мост/u, label)
    const transition = createSceneTransition(plan.sceneArgs, state)
    const map = transition.scene.map
    assert.equal(map.theme, 'building', label)
    assert.ok(map.zones.some((zone) => zone.kind === 'interior' && zone.label), `${label}: у маяка есть помещения`)
    assert.ok(map.doors.length >= 1, `${label}: у маяка есть дверь`)
    assert.ok(!map.zones.some((zone) => /^(?:Река|Мост|Дорога)$/u.test(zone.label)), `${label}: ${map.zones.map((zone) => zone.label).join(', ')}`)
  }
  // Гавань без постройки в имени — край моря, а не два берега с мостом.
  const pier = await new SceneArchitectAgent().plan({
    action: 'Идём к пристани', decision: 'Идём к пристани', destinationHint: 'Северная пристань', destinationLocationId: 'lighthouse',
    state: harbourState({ name: 'Северная пристань', summary: 'Старые причалы над гаванью.' }),
  })
  assert.notEqual(pier.sceneArgs.map.pattern, 'bridge')
  assert.notEqual(pier.sceneArgs.theme, 'берег реки')
})

test('прибытие не обещает моста и реки, которых карта маяка не построила', async () => {
  const state = harbourState()
  const plan = await new SceneArchitectAgent({ llmClient: lighthouseModel }).plan({
    action: 'Идём к старому маяку', decision: 'Идём к старому маяку',
    destinationHint: 'Старый маяк', destinationLocationId: 'lighthouse', state,
  })
  const transition = createSceneTransition(plan.sceneArgs, state)
  assert.ok(!transition.scene.map.zones.some((zone) => /мост/iu.test(zone.label)), 'на карте маяка моста нет')
  assert.doesNotMatch(transition.arrival, /мост/u, transition.arrival)
  assert.match(transition.arrival, /башня маяка/u, 'маяк на карте есть — фраза о нём остаётся')
  assert.match(transition.arrival, /дверь/u, 'дверь на карте есть — фраза о ней остаётся')
  assert.match(transition.arrival, /Вдали у причала/u, 'то, что видно вдали, карте не противоречит')
  assert.match(transition.transition, /покидает таверну/u, 'строка пути об оставленном месте не сверяется с новой картой')
})

test('место, чьё имя называет постройку, без помещений на карте записывается в недостающее', () => {
  const state = harbourState()
  const transition = createSceneTransition({
    title: 'Маяк', location: 'Старый маяк', location_id: 'lighthouse', theme: 'дорога к маяку',
    arrival: 'Перед отрядом поднимается башня маяка. Ветер гонит по дороге песок.',
    map: { theme_id: 'road', layout: 'winding', pattern: 'natural', width: 20, height: 16 },
  }, state)
  assert.ok(!transition.scene.map.zones.some((zone) => zone.kind === 'interior' && zone.label), transition.scene.map.zones.map((zone) => zone.label).join(', '))
  assert.ok(transition.scene.map_requirements?.missing?.includes('lighthouse'), JSON.stringify(transition.scene.map_requirements))
  assert.doesNotMatch(transition.arrival, /башня/u, transition.arrival)
  assert.match(transition.arrival, /Ветер гонит/u)
})

test('место с одним родовым словом в имени находится по склонённому слову', async () => {
  const state = harbourState({ name: 'Маяк', summary: 'Башня на скале.' })
  const plan = await new SceneArchitectAgent().plan({ action: 'Идём к маяку', decision: 'Идём к маяку', destinationHint: 'маяку', state })
  assert.equal(plan.sceneArgs.location, 'Маяк')
  assert.equal(plan.sceneArgs.location_id, 'lighthouse')
})

test('из таверны внутри города к маяку — сразу к маяку, а не сперва «на улицы» того же города', async () => {
  // Замер 2026-10-10: старт «в портовой таверне» стал отдельной точкой карты
  // рядом с городом, и «идём к маяку» первой сценой вело на улицы Серого Причала.
  const state = {
    sessionCode: 'TAVERN-START',
    worldMap: {
      seed: 'tavern', name: 'Берег', width: 1000, height: 640, currentLocationId: 'tavern',
      regions: [{ id: 'r', name: 'Побережье', x: 500, y: 320, radius: 300, biome: 'побережье' }],
      locations: [
        { id: 'port', name: 'Серый Причал', kind: 'port', x: 400, y: 300, regionId: 'r', summary: '', known: true, visited: true },
        { id: 'tavern', name: 'Таверна «Ржавый Якорь»', kind: 'landmark', x: 420, y: 310, regionId: 'r', summary: '', known: true, visited: true },
        { id: 'lighthouse', name: 'Старый Маяк', kind: 'landmark', x: 600, y: 200, regionId: 'r', summary: '', known: true, visited: false },
      ],
      routes: [
        { id: 'r-1', from: 'port', to: 'tavern', kind: 'road', distance: 1, danger: 'низкая', discovered: true },
        { id: 'r-2', from: 'port', to: 'lighthouse', kind: 'trail', distance: 1, danger: 'средняя', discovered: true },
      ],
    },
    scene: { title: 'Таверна', location: 'Таверна «Ржавый Якорь»', location_id: 'tavern', objective: 'Узнать про баркас', turn: 3, cells: [] },
    adventure: { chapter: 1, currentHook: 'Пустой баркас', visitedLocations: ['Таверна «Ржавый Якорь»'], history: [] },
  }
  const planned = await new SceneArchitectAgent().plan({ state, action: 'Идём к маяку', decision: 'Уходим и идём в «Старый Маяк»', destinationHint: 'Старый Маяк', destinationLocationId: 'lighthouse' })
  assert.equal(planned.sceneArgs.location, 'Старый Маяк')
})

test('заведение без слова «таверна» в имени — тоже внутри города: «Ржавый якорь» → сразу к маяку', async () => {
  // Замер 17 (2026-10-11): точка карты называлась просто «Ржавый якорь», и
  // «идём к Заброшенному маяку» вело отряд к воротам Серого Причала.
  const state = {
    sessionCode: 'TAVERN-PLAIN',
    worldMap: {
      seed: 'tavern', name: 'Берег', width: 1000, height: 640, currentLocationId: 'tavern',
      regions: [{ id: 'r', name: 'Побережье', x: 500, y: 320, radius: 300, biome: 'побережье' }],
      locations: [
        { id: 'port', name: 'Серый Причал', kind: 'port', x: 400, y: 300, regionId: 'r', summary: '', known: true, visited: true },
        { id: 'tavern', name: 'Ржавый якорь', kind: 'landmark', x: 420, y: 310, regionId: 'r', summary: '', known: true, visited: true },
        { id: 'lighthouse', name: 'Заброшенный маяк', kind: 'landmark', x: 600, y: 200, regionId: 'r', summary: '', known: true, visited: false },
      ],
      routes: [
        { id: 'r-1', from: 'port', to: 'tavern', kind: 'road', distance: 1, danger: 'низкая', discovered: true },
        { id: 'r-2', from: 'port', to: 'lighthouse', kind: 'trail', distance: 1, danger: 'средняя', discovered: true },
      ],
    },
    scene: { title: 'Прибытие в «Ржавый якорь»', location: 'Ржавый якорь', location_id: 'tavern', theme: 'tavern', objective: 'Узнать про баркас', turn: 3, cells: [] },
    adventure: { chapter: 1, currentHook: 'Пустой баркас', visitedLocations: ['Ржавый якорь'], history: [] },
  }
  const planned = await new SceneArchitectAgent().plan({ state, action: 'Идём к маяку', decision: 'Уходим и идём в «Заброшенный маяк»', destinationHint: 'Заброшенный маяк', destinationLocationId: 'lighthouse' })
  assert.equal(planned.sceneArgs.location, 'Заброшенный маяк')
})

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
  assert.equal(transition.scene.cells.length, 20 * 20)
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
  assert.deepEqual(Object.keys(brief.known_destinations[0]).sort(), ['danger', 'days', 'kind', 'name', 'visited'])
  let capturedRequest = null
  const architect = new SceneArchitectAgent({ llmClient: { async completeJson(request) { capturedRequest = request; return {} } } })
  await architect.plan({ action: '[РЕШЕНИЕ ГРУППЫ] Покинуть «Тихий Брод»', state: brodState, decision: 'Покинуть «Тихий Брод»', destinationHint: '' })
  const context = untrustedPayload(capturedRequest.messages[1].content, 'scene_planning')
  assert.equal(context.known_destinations[0].name, 'Эствуд')
  assert.match(capturedRequest.messages[0].content, /known_destinations/u)
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
    destinationHint: 'Дальний форт',
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
  assert.equal(createSceneTransition(failed.sceneArgs, archiveState).scene.cells.length, 20 * 20)

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
  assert.equal(transition.scene.cells.length, 19 * 16)
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
